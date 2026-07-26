import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import test from "node:test";
import type { Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { createFauxCore, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
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
import { runBackendConformance } from "../src/testing/index.ts";

const PROVIDER = "pi-subagent-runtime-subprocess-fixture";
const MODEL_ID = "fixture-model";
const API = "pi-subagent-runtime-subprocess-api";

test("subprocess backend prepares through the parent model runtime, executes a fresh child, and retains a sanitized report", async () => {
  const tempDirectoriesBefore = subprocessTempDirectories();
  const providerContexts: Context[] = [];
  const faux = createFauxCore({
    api: API,
    provider: PROVIDER,
    models: [{ id: MODEL_ID, name: "Fixture", reasoning: true }],
  });
  faux.setResponses([
    (context) => {
      providerContexts.push(structuredClone(context));
      throw new Error("dry preparation must not reach this provider");
    },
  ]);
  const { modelRegistry } = await fixtureModelRuntime(faux);
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

test("subprocess cancellation waits for the child to close and terminalizes its report", async () => {
  const tempDirectoriesBefore = subprocessTempDirectories();
  const faux = createFauxCore({
    api: API,
    provider: PROVIDER,
    models: [{ id: MODEL_ID, name: "Fixture", reasoning: true }],
  });
  faux.setResponses([
    () => {
      throw new Error("dry preparation must not reach this provider");
    },
  ]);
  const { modelRegistry } = await fixtureModelRuntime(faux);
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
    'process.on("SIGTERM", () => setTimeout(() => process.exit(0), 60));',
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
    const cancelledAt = Date.now();
    await run.cancel("fixture cancellation");
    const result = await run.result;
    assert.equal(result.status, "cancelled");
    assert.ok(
      Date.now() - cancelledAt >= 40,
      "the result must wait for the child close event",
    );
    const report = backend.takeReport(prepared.id);
    assert.equal(report?.status, "cancelled");
    assert.ok(report?.finishedAt);
  } finally {
    await runtime.dispose();
    await backend.dispose();
    modelRegistry.unregisterProvider(PROVIDER);
  }
  assert.deepEqual(subprocessTempDirectories(), tempDirectoriesBefore);
});

test("subprocess backend disposal waits for active children instead of orphaning them", async () => {
  const tempDirectoriesBefore = subprocessTempDirectories();
  const faux = createFauxCore({
    api: API,
    provider: PROVIDER,
    models: [{ id: MODEL_ID, name: "Fixture", reasoning: true }],
  });
  faux.setResponses([
    () => {
      throw new Error("dry preparation must not reach this provider");
    },
  ]);
  const { modelRegistry } = await fixtureModelRuntime(faux);
  const startedEvent = fixtureEvents().at(-1);
  const script = [
    'const { writeSync } = await import("node:fs");',
    'process.on("SIGTERM", () => setTimeout(() => process.exit(0), 60));',
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
    const disposedAt = Date.now();
    await backend.dispose();
    assert.ok(
      Date.now() - disposedAt >= 40,
      "dispose must wait for the child close event",
    );
    const result = await run.result;
    assert.equal(result.status, "cancelled");
  } finally {
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
  const faux = createFauxCore({
    api: API,
    provider: PROVIDER,
    models: [{ id: MODEL_ID, name: "Fixture", reasoning: true }],
  });
  const { modelRegistry, modelRuntime } = await fixtureModelRuntime(faux);
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
  const faux = createFauxCore({
    api: API,
    provider: PROVIDER,
    models: [{ id: MODEL_ID, name: "Fixture", reasoning: true }],
  });
  faux.setResponses([
    () => {
      throw new Error("dry preparation must not reach this provider");
    },
  ]);
  const { modelRegistry } = await fixtureModelRuntime(faux);
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

async function fixtureModelRuntime(
  faux: ReturnType<typeof createFauxCore>,
): Promise<{ modelRegistry: ModelRegistry; modelRuntime: ModelRuntime }> {
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    allowModelNetwork: false,
  });
  modelRuntime.registerProvider(PROVIDER, {
    api: API,
    baseUrl: "https://fixture.invalid",
    apiKey: "fixture-key",
    streamSimple: (
      model: Model<any>,
      context: Context,
      options?: SimpleStreamOptions,
    ) => faux.streamSimple(model, context, options),
    models: [
      {
        id: MODEL_ID,
        name: "Fixture model",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 32_000,
        maxTokens: 4_000,
      },
    ],
  });
  return { modelRuntime, modelRegistry: new ModelRegistry(modelRuntime) };
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
    .filter((name) => name.startsWith("pi-subagent-runtime-"))
    .sort();
}
