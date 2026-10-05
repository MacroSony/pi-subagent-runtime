import assert from "node:assert/strict";
import { ChildProcess } from "node:child_process";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import test, { type TestContext } from "node:test";
import { setImmediate } from "node:timers/promises";
import type { Context } from "@earendil-works/pi-ai";
import { createFixturePiRuntime } from "./helpers/fixture-pi-runtime.ts";
import type {
  ExecutionIntent,
  PreparedConversation,
  PromptRuntime,
  RunEvent,
} from "../src/core/index.ts";
import { createExecutionRuntime } from "../src/runtime/index.ts";
import {
  MAX_RETAINED_SUBPROCESS_REPORT_BYTES,
  PI_SUBPROCESS_READONLY_BACKEND_ID,
  PiSubprocessBackend,
  sanitizePiSubprocessRunReport,
  type PiSubprocessRunReport,
} from "../src/backends/subprocess/pi-subprocess-backend.ts";
import { createSubprocessBridge } from "../src/backends/subprocess/subprocess-bridge.ts";
import { MAX_SUBPROCESS_REPORT_STRING_BYTES } from "../src/backends/subprocess/subprocess-report.ts";
import { modelRuntimeFromRegistry } from "../src/backends/shared/pi-model-runtime.ts";
import { runBackendConformance } from "../src/testing/index.ts";

const PROVIDER = "pi-subagent-runtime-subprocess-fixture";
const MODEL_ID = "fixture-model";
const API = "pi-subagent-runtime-subprocess-api";

test("process backends resolve host model runtimes by capability", async () => {
  const { modelRegistry, modelRuntime } = await createFixturePiRuntime({
    provider: PROVIDER,
    api: API,
    modelId: MODEL_ID,
  });
  try {
    assert.equal(modelRuntimeFromRegistry(modelRegistry), modelRuntime);
    assert.throws(
      () => modelRuntimeFromRegistry({} as Parameters<typeof modelRuntimeFromRegistry>[0]),
      /compatible authenticated ModelRuntime/,
    );
  } finally {
    modelRegistry.unregisterProvider(PROVIDER);
  }
});

test("subprocess backend prepares through the parent model runtime, executes a fresh child, and retains a sanitized report", async () => {
  const tempDirectoriesBefore = subprocessTempDirectories();
  const providerContexts: Context[] = [];
  const { faux, modelRegistry } = await createFixturePiRuntime({
    provider: PROVIDER,
    api: API,
    modelId: MODEL_ID,
  });
  faux.setResponses([
    (context) => {
      providerContexts.push(structuredClone(context));
      throw new Error("dry preparation must not reach this provider");
    },
  ]);

  const invocationArgs: string[][] = [];
  const events = fixtureEvents();
  const backend = new PiSubprocessBackend({
    modelRegistry,
    cwd: process.cwd(),
    invocationFactory: (args) => {
      invocationArgs.push([...args]);
      return {
        command: process.execPath,
        args: [
          "--input-type=module",
          "-e",
          `const { writeSync } = await import("node:fs"); for (const event of ${JSON.stringify(events)}) writeSync(3, JSON.stringify(event) + "\\n");`,
        ],
      };
    },
  });
  const runtime = createExecutionRuntime();
  runtime.registerBackend(backend);

  try {
    let compiledRuntime: PromptRuntime | undefined;
    const prepared = await runtime.prepare({
      backendId: PI_SUBPROCESS_READONLY_BACKEND_ID,
      intent: fixtureIntent(),
      compile: async (promptRuntime) => {
        compiledRuntime = promptRuntime;
        return fixtureConversation();
      },
    });
    assert.equal(providerContexts.length, 0);
    assert.ok(compiledRuntime);
    assert.equal(compiledRuntime!.fidelity, "backend-assisted");
    assert.equal(compiledRuntime!.model.provider, PROVIDER);

    const plan = prepared.snapshot();
    assert.equal(plan.backendId, PI_SUBPROCESS_READONLY_BACKEND_ID);
    assert.equal(plan.preflight.access.executionBoundary, "shared-user");
    assert.equal(plan.preflight.access.enforcement.readOnlyMountIsolation, false);
    assert.deepEqual(
      plan.preflight.toolCatalog.map((tool) => tool.name),
      ["read", "grep", "find", "ls"],
    );
    assert.deepEqual(
      plan.effectiveTools.map((tool) => tool.backendToolName),
      ["read", "grep", "find", "ls"],
    );
    assert.ok(
      plan.preflight.diagnostics.some(
        (item) => item.code === "pi-subprocess.shared-user",
      ),
    );
    assert.equal(plan.conversation.systemPrompt, fixtureConversation().systemPrompt);
    assert.equal(plan.promptRuntime.promptRuntimeFingerprint, prepared.snapshot().promptRuntime.promptRuntimeFingerprint);

    const runEvents: RunEvent[] = [];
    const run = runtime.execute(prepared);
    run.subscribe((event) => runEvents.push(event));
    const result = await run.result;

    assert.equal(result.status, "completed");
    if (result.status !== "completed") return;
    assert.equal(result.output.text, "Fixture subprocess complete.");
    assert.equal(result.output.partial, false);
    assert.equal(result.usage?.tokens?.total, 15);
    assert.deepEqual(result.usage?.requests, {
      total: 1,
      cacheKnown: 1,
      usageKnown: 1,
    });
    assert.deepEqual(
      {
        cacheRead: result.usage?.tokens?.cacheRead,
        cacheWrite: result.usage?.tokens?.cacheWrite,
      },
      { cacheRead: 0, cacheWrite: 0 },
    );
    assert.equal(providerContexts.length, 0);
    assert.equal(invocationArgs.length, 1);
    assertContainsFlag(invocationArgs[0]!, "--tools", "read,grep,find,ls");
    assertContainsFlag(invocationArgs[0]!, "--model", `${PROVIDER}/${MODEL_ID}`);
    assertContainsFlag(invocationArgs[0]!, "--mode", "text");
    for (const flag of [
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-context-files",
    ]) {
      assert.ok(invocationArgs[0]!.includes(flag), flag);
    }
    assert.ok(
      runEvents.some(
        (event) => event.phase === "tool-result" && event.message.startsWith("read completed"),
      ),
    );
    assert.ok(
      runEvents.some(
        (event) => event.phase === "finishing" && event.message === "Subagent report ready.",
      ),
    );

    const report = backend.takeReport(prepared.id);
    assert.ok(report);
    assert.equal(report.status, "completed");
    assert.equal(report.executionBoundary, "shared-user");
    assert.equal(report.executionFingerprint, plan.executionFingerprint);
    assert.equal(report.messages.length, 2);
    const retainedJson = JSON.stringify(report);
    assert.doesNotMatch(retainedJson, /fixture-image-base64/);
    assert.match(retainedJson, /"dataOmitted":true/);
    assert.match(retainedJson, /"encodedBytes":20/);
    assert.equal(report.usage.turns, 1);
    assert.equal(report.usage.totalTokens, 15);
    assert.equal(backend.takeReport(prepared.id), undefined);
  } finally {
    await runtime.dispose();
    await backend.dispose();
    modelRegistry.unregisterProvider(PROVIDER);
  }
  assert.deepEqual(subprocessTempDirectories(), tempDirectoriesBefore);
});

test("subprocess cancellation waits for the child to close and terminalizes its report", { timeout: 20_000 }, async (t) => {
  const tempDirectoriesBefore = subprocessTempDirectories();
  const { faux, modelRegistry } = await createFixturePiRuntime({
    provider: PROVIDER,
    api: API,
    modelId: MODEL_ID,
  });
  faux.setResponses([
    () => {
      throw new Error("dry preparation must not reach this provider");
    },
  ]);

  const startedEvent = {
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "Subprocess started." }],
      api: API,
      provider: PROVIDER,
      model: MODEL_ID,
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 1,
    },
  };
  const script = [
    'const { writeSync } = await import("node:fs");',
    `writeSync(3, JSON.stringify(${JSON.stringify(startedEvent)}) + "\\n");`,
    "setInterval(() => undefined, 1_000);",
  ].join("\n");
  const backend = new PiSubprocessBackend({
    modelRegistry,
    cwd: process.cwd(),
    invocationFactory: () => ({
      command: process.execPath,
      args: ["--input-type=module", "-e", script],
    }),
  });
  const runtime = createExecutionRuntime();
  runtime.registerBackend(backend);

  const termination = holdChildTermination(t);
  try {
    const prepared = await runtime.prepare({
      backendId: PI_SUBPROCESS_READONLY_BACKEND_ID,
      intent: fixtureIntent(),
      compile: async () => fixtureConversation(),
    });
    let notifyStarted!: () => void;
    const childStarted = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    const run = runtime.execute(prepared);
    run.subscribe((event) => {
      if (event.phase === "message" && event.message.includes("Subprocess started")) {
        notifyStarted();
      }
    });
    await childStarted;
    let cancelSettled = false;
    let resultSettled = false;
    const resultPromise = run.result.then((result) => {
      resultSettled = true;
      assert.equal(termination.closed, true, "result must follow the real child close event");
      return result;
    });
    const cancellation = run.cancel("fixture cancellation").then(() => {
      cancelSettled = true;
      assert.equal(termination.closed, true, "cancel must wait for the real child close event");
    });
    // Attach failure handlers immediately; the original promises are awaited below.
    void resultPromise.catch(() => undefined);
    void cancellation.catch(() => undefined);
    await termination.requested;
    await setImmediate(); // Flush premature promise completion, not a timing threshold.
    assert.equal(termination.closed, false);
    assert.equal(cancelSettled, false, "cancel cannot settle while termination is held");
    assert.equal(resultSettled, false, "result cannot settle while the child is alive");
    termination.release();
    await cancellation;
    const result = await resultPromise;
    assert.equal(result.status, "cancelled");
    const report = backend.takeReport(prepared.id);
    assert.equal(report?.status, "cancelled");
    assert.ok(report?.finishedAt);
  } finally {
    termination.release();
    await runtime.dispose();
    await backend.dispose();
    modelRegistry.unregisterProvider(PROVIDER);
  }
  assert.deepEqual(subprocessTempDirectories(), tempDirectoriesBefore);
});

test("subprocess backend disposal waits for active children instead of orphaning them", { timeout: 20_000 }, async (t) => {
  const tempDirectoriesBefore = subprocessTempDirectories();
  const { faux, modelRegistry } = await createFixturePiRuntime({
    provider: PROVIDER,
    api: API,
    modelId: MODEL_ID,
  });
  faux.setResponses([
    () => {
      throw new Error("dry preparation must not reach this provider");
    },
  ]);

  const startedEvent = fixtureEvents().at(-1);
  const script = [
    'const { writeSync } = await import("node:fs");',
    `writeSync(3, JSON.stringify(${JSON.stringify(startedEvent)}) + "\\n");`,
    "setInterval(() => undefined, 1_000);",
  ].join("\n");
  const backend = new PiSubprocessBackend({
    modelRegistry,
    cwd: process.cwd(),
    invocationFactory: () => ({
      command: process.execPath,
      args: ["--input-type=module", "-e", script],
    }),
  });
  const runtime = createExecutionRuntime();
  runtime.registerBackend(backend);

  const termination = holdChildTermination(t);
  try {
    const prepared = await runtime.prepare({
      backendId: PI_SUBPROCESS_READONLY_BACKEND_ID,
      intent: fixtureIntent(),
      compile: async () => fixtureConversation(),
    });
    let notifyStarted!: () => void;
    const childStarted = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    const run = runtime.execute(prepared);
    run.subscribe((event) => {
      if (event.phase === "message") notifyStarted();
    });
    await childStarted;
    let disposeSettled = false;
    let resultSettled = false;
    const resultPromise = run.result.then((result) => {
      resultSettled = true;
      assert.equal(termination.closed, true, "result must follow the real child close event");
      return result;
    });
    const disposal = backend.dispose().then(() => {
      disposeSettled = true;
      assert.equal(termination.closed, true, "dispose must wait for the real child close event");
    });
    void resultPromise.catch(() => undefined);
    void disposal.catch(() => undefined);
    await termination.requested;
    await setImmediate();
    assert.equal(termination.closed, false);
    assert.equal(disposeSettled, false, "dispose cannot settle while termination is held");
    assert.equal(resultSettled, false, "result cannot settle while the child is alive");
    termination.release();
    await disposal;
    const result = await resultPromise;
    assert.equal(result.status, "cancelled");
  } finally {
    termination.release();
    await runtime.dispose();
    await backend.dispose();
    modelRegistry.unregisterProvider(PROVIDER);
  }
  assert.deepEqual(subprocessTempDirectories(), tempDirectoriesBefore);
});

test("subprocess bridge replaces only the marker and blocks tools outside the approved plan", () => {
  const handlers: Record<string, Function> = {};
  const reportEvents: unknown[] = [];
  const input = {
    marker: "fixture-marker",
    systemPrompt: "Exact compiled prompt",
    messages: [
      {
        role: "user" as const,
        content: [{ type: "text" as const, text: "Prepared task" }],
      },
    ],
    model: { provider: PROVIDER, id: MODEL_ID },
    effectiveToolNames: ["read"],
  };
  createSubprocessBridge(input, {
    report: (event) => reportEvents.push(event),
  })({
    on: (name: string, handler: Function) => {
      handlers[name] = handler;
    },
  } as any);
  assert.deepEqual(handlers.before_agent_start?.({ systemPrompt: "other" }), {
    systemPrompt: input.systemPrompt,
  });
  const transformed = handlers.context?.({
    messages: [
      { role: "user", content: input.marker, timestamp: 0 },
      {
        role: "toolResult",
        toolCallId: "tool",
        toolName: "read",
        content: [{ type: "text", text: "kept" }],
        isError: false,
        timestamp: 1,
      },
    ],
  });
  assert.equal(transformed.messages[0].content, "Prepared task");
  assert.equal(transformed.messages[1].role, "toolResult");
  assert.equal(handlers.tool_call?.({ toolName: "read" }), undefined);
  assert.match(handlers.tool_call?.({ toolName: "write" }).reason, /outside the approved/);

  const imageData = "x".repeat(3_600_000);
  const imageMessage = {
    role: "toolResult",
    toolName: "read",
    content: [{ type: "image", data: imageData, mimeType: "image/png" }],
  };
  handlers.message_end?.({ message: imageMessage });
  assert.equal(
    imageMessage.content[0]?.data.length,
    imageData.length,
    "the child model context keeps the image",
  );
  const reportJson = JSON.stringify(reportEvents[0]);
  assert.ok(Buffer.byteLength(reportJson) < 1_024, String(reportJson.length));
  assert.doesNotMatch(reportJson, /x{100}/);
  assert.match(reportJson, /"dataOmitted":true/);
  assert.match(reportJson, /"encodedBytes":3600000/);

  const base64Text = "QUJD".repeat(900_000);
  const assistantMessage = {
    role: "assistant",
    content: [{ type: "text", text: base64Text }],
  };
  handlers.message_end?.({ message: assistantMessage });
  assert.equal(
    assistantMessage.content[0]!.text.length,
    base64Text.length,
    "the child assistant event remains unchanged",
  );
  const assistantReportJson = JSON.stringify(reportEvents.at(-1));
  assert.ok(Buffer.byteLength(assistantReportJson, "utf8") < 1_024);
  assert.match(assistantReportJson, /Base64-like data omitted/);
});

test("retained subprocess reports bound strings and keep a rolling transcript tail", () => {
  const messages = Array.from({ length: 12 }, (_, index) => ({
    role: "toolResult",
    toolName: "read",
    content: [
      { type: "text", text: `result-${index}\n${"ordinary words ".repeat(8_000)}` },
    ],
    isError: false,
  }));
  messages.push({
    role: "assistant",
    toolName: "",
    content: [{ type: "text", text: "Final retained report." }],
    isError: false,
  });
  const report: PiSubprocessRunReport = {
    preparedRunId: "retention-run",
    executionFingerprint: "sha256:v1:retention",
    status: "completed",
    startedAt: "2026-07-18T12:00:00.000Z",
    finishedAt: "2026-07-18T12:00:01.000Z",
    exitCode: 0,
    model: { provider: PROVIDER, id: MODEL_ID },
    thinkingLevel: "low",
    effectiveToolNames: ["read"],
    executionBoundary: "shared-user",
    workingDirectory: "/workspace",
    messages,
    retention: {
      maxBytes: MAX_RETAINED_SUBPROCESS_REPORT_BYTES,
      retainedBytes: 0,
      truncated: false,
      omittedMessages: 0,
    },
    stderr: "",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: 0,
      turns: 1,
    },
  };

  const sanitized = sanitizePiSubprocessRunReport(report);
  assert.equal(sanitized.retention.maxBytes, MAX_RETAINED_SUBPROCESS_REPORT_BYTES);
  assert.ok(sanitized.retention.retainedBytes <= MAX_RETAINED_SUBPROCESS_REPORT_BYTES);
  assert.equal(sanitized.retention.truncated, true);
  assert.ok(sanitized.retention.omittedMessages > 0);
  assert.match(JSON.stringify(sanitized.messages.at(-1)), /Final retained report/);
  assert.ok(
    JSON.stringify(sanitized.messages).includes(
      "Text truncated in retained subagent report",
    ),
  );
  for (const message of sanitized.messages) {
    const text = JSON.stringify(message);
    assert.ok(
      Buffer.byteLength(text, "utf8") <= MAX_SUBPROCESS_REPORT_STRING_BYTES + 1_024,
    );
  }
});

test("subprocess backend rejects intents a shared-user child cannot enforce", async () => {
  const { faux, modelRegistry, modelRuntime } = await createFixturePiRuntime({
    provider: PROVIDER,
    api: API,
    modelId: MODEL_ID,
  });

  const backend = new PiSubprocessBackend({
    modelRegistry,
    modelRuntime,
    cwd: process.cwd(),
  });
  try {
    const denied = backend.preflight({
      intent: fixtureIntent({
        access: {
          level: "none",
          executionBoundary: "shared-user",
          workspaces: [],
          network: "deny",
        },
      }),
      signal: new AbortController().signal,
    });
    assert.equal(denied.status, "rejected");
    for (const code of [
      "pi-subprocess.access",
      "pi-subprocess.cwd",
      "pi-subprocess.network",
    ]) {
      assert.ok(
        denied.diagnostics.some((item) => item.code === code),
        code,
      );
    }

    const isolated = backend.preflight({
      intent: fixtureIntent({
        access: {
          level: "read-only",
          executionBoundary: "isolated",
          workspaces: [{ handle: "project", mode: "read-only" }],
          workingDirectory: { workspaceHandle: "project", path: "." },
          network: "allow",
        },
      }),
      signal: new AbortController().signal,
    });
    assert.equal(isolated.status, "rejected");
    assert.ok(
      isolated.diagnostics.some((item) => item.code === "pi-subprocess.boundary"),
    );

    const unknownTool = backend.preflight({
      intent: fixtureIntent({ requestedTools: ["read", "bash"] }),
      signal: new AbortController().signal,
    });
    assert.equal(unknownTool.status, "rejected");
    assert.ok(
      unknownTool.diagnostics.some((item) => item.code === "pi-subprocess.tool"),
    );

    const requiredHardTimeout = backend.preflight({
      intent: fixtureIntent({
        limits: { timeoutMs: { value: 1_000, enforcement: "required" } },
      }),
      signal: new AbortController().signal,
    });
    assert.equal(requiredHardTimeout.status, "rejected");
    assert.ok(
      requiredHardTimeout.diagnostics.some(
        (item) => item.code === "pi-subprocess.limit",
      ),
    );

    const unknownModel = backend.preflight({
      intent: fixtureIntent({ model: { provider: PROVIDER, id: "missing" } }),
      signal: new AbortController().signal,
    });
    assert.equal(unknownModel.status, "rejected");
    assert.ok(
      unknownModel.diagnostics.some((item) => item.code === "pi-subprocess.model"),
    );

    const missingThinkingIntent = fixtureIntent();
    delete (missingThinkingIntent as { thinkingLevel?: string }).thinkingLevel;
    const missingThinking = backend.preflight({
      intent: missingThinkingIntent,
      signal: new AbortController().signal,
    });
    assert.equal(missingThinking.status, "rejected");
    assert.ok(
      missingThinking.diagnostics.some(
        (item) => item.code === "pi-subprocess.thinking",
      ),
    );
  } finally {
    await backend.dispose();
    modelRegistry.unregisterProvider(PROVIDER);
  }
});

test("subprocess backend passes the reusable conformance suite", async () => {
  const { faux, modelRegistry } = await createFixturePiRuntime({
    provider: PROVIDER,
    api: API,
    modelId: MODEL_ID,
  });
  faux.setResponses([
    () => {
      throw new Error("dry preparation must not reach this provider");
    },
  ]);

  const events = fixtureEvents();
  const backend = new PiSubprocessBackend({
    modelRegistry,
    cwd: process.cwd(),
    invocationFactory: () => ({
      command: process.execPath,
      args: [
        "--input-type=module",
        "-e",
        `const { writeSync } = await import("node:fs"); for (const event of ${JSON.stringify(events)}) writeSync(3, JSON.stringify(event) + "\\n");`,
      ],
    }),
  });
  try {
    const report = await runBackendConformance({
      backend,
      intent: () => fixtureIntent(),
      compile: async () => fixtureConversation(),
    });
    assert.equal(report.backendId, PI_SUBPROCESS_READONLY_BACKEND_ID);
    assert.equal(report.result.status, "completed");
    assert.ok(report.eventCount >= 1);
  } finally {
    await backend.dispose();
    modelRegistry.unregisterProvider(PROVIDER);
  }
});

function fixtureIntent(overrides: Partial<ExecutionIntent> = {}): ExecutionIntent {
  return {
    model: { provider: PROVIDER, id: MODEL_ID },
    thinkingLevel: "high",
    requestedTools: ["read", "grep", "find", "ls"],
    access: {
      level: "read-only",
      executionBoundary: "shared-user",
      workspaces: [{ handle: "project", mode: "read-only" }],
      workingDirectory: { workspaceHandle: "project", path: "." },
      network: "allow",
    },
    limits: { timeoutMs: { value: 30_000, enforcement: "best-effort" } },
    ...overrides,
  };
}

function fixtureConversation(): PreparedConversation {
  return {
    systemPrompt: "You are the Fixture subprocess reviewer.",
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "Inspect the fixture workspace." }],
      },
    ],
  };
}


function fixtureEvents(): unknown[] {
  return [
    {
      type: "message_end",
      message: {
        role: "toolResult",
        toolCallId: "tool-1",
        toolName: "read",
        content: [
          { type: "text", text: "fixture source" },
          { type: "image", data: "fixture-image-base64", mimeType: "image/png" },
        ],
        details: {},
        isError: false,
        timestamp: 1,
      },
    },
    {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Fixture subprocess complete." }],
        api: API,
        provider: PROVIDER,
        model: MODEL_ID,
        usage: {
          input: 10,
          output: 5,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 15,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: 2,
      },
    },
  ];
}

function assertContainsFlag(args: string[], flag: string, value: string): void {
  const index = args.indexOf(flag);
  assert.notEqual(index, -1, flag);
  assert.equal(args[index + 1], value);
}

function subprocessTempDirectories(): string[] {
  return readdirSync(tmpdir())
    .filter(
      (name) =>
        name.startsWith("pi-subagent-runtime-prepare-") ||
        name.startsWith("pi-subagent-runtime-run-"),
    )
    .sort();
}

/** Hold the termination request, not a POSIX SIGTERM handler in the child.
 * The child, OS termination and close event stay real on every platform.
 * Tests in this file are serial; TestContext restores the prototype mock.
 */
function holdChildTermination(t: TestContext) {
  const kill = ChildProcess.prototype.kill;
  let child: ChildProcess | undefined;
  let released = false;
  let closed = false;
  let notifyRequested!: () => void;
  const requested = new Promise<void>((resolve) => { notifyRequested = resolve; });
  const release = () => {
    if (released) return;
    released = true;
    if (child && !closed) kill.call(child, "SIGTERM");
  };
  t.after(release);
  t.mock.method(ChildProcess.prototype, "kill", function (
    this: ChildProcess,
    signal?: NodeJS.Signals | number,
  ) {
    if (signal !== "SIGTERM") return kill.call(this, signal);
    if (!child) {
      child = this;
      this.once("close", () => { closed = true; });
      notifyRequested();
    } else {
      assert.equal(this, child, "termination gate must only target the test child");
    }
    return released ? kill.call(this, signal) : true;
  });
  return { requested, release, get closed() { return closed; } };
}
