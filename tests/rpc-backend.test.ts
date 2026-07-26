import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import test from "node:test";
import type { Context } from "@earendil-works/pi-ai";
import { createFixturePiRuntime } from "./helpers/fixture-pi-runtime.ts";
import type {
  ExecutionIntent,
  PreparedConversation,
  RunEvent,
} from "../src/core/index.ts";
import { createExecutionRuntime } from "../src/runtime/index.ts";
import { PiSubprocessBackend } from "../src/backends/subprocess/pi-subprocess-backend.ts";
import {
  PI_RPC_READONLY_BACKEND_ID,
  PiRpcBackend,
} from "../src/backends/rpc/pi-rpc-backend.ts";
import { runBackendConformance } from "../src/testing/index.ts";

const PROVIDER = "pi-subagent-runtime-rpc-fixture";
const MODEL_ID = "fixture-model";
const API = "pi-subagent-runtime-rpc-api";

test("RPC backend sends the marker over JSONL, streams events, and settles with usage and a sanitized report", async () => {
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
  const backend = new PiRpcBackend({
    modelRegistry,
    cwd: process.cwd(),
    invocationFactory: (args) => {
      invocationArgs.push([...args]);
      return {
        command: process.execPath,
        args: ["--input-type=module", "-e", scriptedRpcChildScript()],
      };
    },
  });
  const runtime = createExecutionRuntime();
  runtime.registerBackend(backend);

  try {
    const prepared = await runtime.prepare({
      backendId: PI_RPC_READONLY_BACKEND_ID,
      intent: fixtureIntent(),
      compile: async () => fixtureConversation(),
    });
    assert.equal(providerContexts.length, 0);
    const plan = prepared.snapshot();
    assert.equal(plan.backendId, PI_RPC_READONLY_BACKEND_ID);
    assert.equal(plan.preflight.access.executionBoundary, "shared-user");

    const runEvents: RunEvent[] = [];
    const run = runtime.execute(prepared);
    run.subscribe((event) => runEvents.push(event));
    const result = await run.result;

    assert.equal(result.status, "completed");
    if (result.status !== "completed") return;
    assert.equal(result.output.text, "Fixture RPC complete.");
    assert.equal(result.usage?.tokens?.total, 15);
    assert.equal(providerContexts.length, 0);
    assert.equal(invocationArgs.length, 1);
    assertContainsFlag(invocationArgs[0]!, "--mode", "rpc");
    assertContainsFlag(invocationArgs[0]!, "--tools", "read,grep,find,ls");
    assertContainsFlag(invocationArgs[0]!, "--model", `${PROVIDER}/${MODEL_ID}`);
    for (const flag of [
      "--no-session",
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
    assert.equal(report.executionFingerprint, plan.executionFingerprint);
    const retainedJson = JSON.stringify(report);
    assert.doesNotMatch(retainedJson, /fixture-image-base64/);
    assert.match(retainedJson, /"dataOmitted":true/);
    assert.equal(report.usage.turns, 1);
    assert.equal(report.usage.totalTokens, 15);
  } finally {
    await runtime.dispose();
    await backend.dispose();
    modelRegistry.unregisterProvider(PROVIDER);
  }
  assert.deepEqual(subprocessTempDirectories(), tempDirectoriesBefore);
});

test("RPC cancellation uses the abort command and settles cancelled after the child closes", async () => {
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

  const backend = new PiRpcBackend({
    modelRegistry,
    cwd: process.cwd(),
    invocationFactory: () => ({
      command: process.execPath,
      args: ["--input-type=module", "-e", scriptedRpcChildScript({ honorAbort: true })],
    }),
  });
  const runtime = createExecutionRuntime();
  runtime.registerBackend(backend);

  try {
    const prepared = await runtime.prepare({
      backendId: PI_RPC_READONLY_BACKEND_ID,
      intent: fixtureIntent(),
      compile: async () => fixtureConversation(),
    });
    let notifyStarted!: () => void;
    const childStarted = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    const run = runtime.execute(prepared);
    run.subscribe((event) => {
      if (event.phase === "message" && event.message.includes("RPC started")) {
        notifyStarted();
      }
    });
    await childStarted;
    await run.cancel("fixture RPC cancellation");
    const result = await run.result;
    assert.equal(result.status, "cancelled");
    if (result.status === "cancelled") {
      assert.equal(result.reason, "fixture RPC cancellation");
    }
    const report = backend.takeReport(prepared.id);
    assert.equal(report?.status, "cancelled");
  } finally {
    await runtime.dispose();
    await backend.dispose();
    modelRegistry.unregisterProvider(PROVIDER);
  }
});

test("RPC cancellation escalates to process termination when abort does not settle", async () => {
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

  const backend = new PiRpcBackend({
    modelRegistry,
    cwd: process.cwd(),
    abortSettleMs: 150,
    invocationFactory: () => ({
      command: process.execPath,
      args: [
        "--input-type=module",
        "-e",
        scriptedRpcChildScript({ honorAbort: false, sigtermDelayMs: 60 }),
      ],
    }),
  });
  const runtime = createExecutionRuntime();
  runtime.registerBackend(backend);

  try {
    const prepared = await runtime.prepare({
      backendId: PI_RPC_READONLY_BACKEND_ID,
      intent: fixtureIntent(),
      compile: async () => fixtureConversation(),
    });
    let notifyStarted!: () => void;
    const childStarted = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    const run = runtime.execute(prepared);
    run.subscribe((event) => {
      if (event.phase === "message" && event.message.includes("RPC started")) {
        notifyStarted();
      }
    });
    await childStarted;
    const cancelledAt = Date.now();
    await run.cancel("escalated cancellation");
    const result = await run.result;
    assert.equal(result.status, "cancelled");
    assert.ok(
      Date.now() - cancelledAt >= 150,
      "the abort settle bound must elapse before escalation",
    );
    const report = backend.takeReport(prepared.id);
    assert.equal(report?.status, "cancelled");
  } finally {
    await runtime.dispose();
    await backend.dispose();
    modelRegistry.unregisterProvider(PROVIDER);
  }
});

test("RPC backend disposal cancels active children", async () => {
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

  const backend = new PiRpcBackend({
    modelRegistry,
    cwd: process.cwd(),
    abortSettleMs: 100,
    invocationFactory: () => ({
      command: process.execPath,
      args: [
        "--input-type=module",
        "-e",
        scriptedRpcChildScript({ honorAbort: true }),
      ],
    }),
  });
  const runtime = createExecutionRuntime();
  runtime.registerBackend(backend);

  try {
    const prepared = await runtime.prepare({
      backendId: PI_RPC_READONLY_BACKEND_ID,
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
    await backend.dispose();
    const result = await run.result;
    assert.equal(result.status, "cancelled");
  } finally {
    await runtime.dispose();
    await backend.dispose();
    modelRegistry.unregisterProvider(PROVIDER);
  }
});

test("RPC backend fails closed when the marker prompt is rejected before transport", async () => {
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

  const backend = new PiRpcBackend({
    modelRegistry,
    cwd: process.cwd(),
    invocationFactory: () => ({
      command: process.execPath,
      args: [
        "--input-type=module",
        "-e",
        scriptedRpcChildScript({ rejectPrompt: true }),
      ],
    }),
  });
  const runtime = createExecutionRuntime();
  runtime.registerBackend(backend);

  try {
    const prepared = await runtime.prepare({
      backendId: PI_RPC_READONLY_BACKEND_ID,
      intent: fixtureIntent(),
      compile: async () => fixtureConversation(),
    });
    const run = runtime.execute(prepared);
    const result = await run.result;
    assert.equal(result.status, "failed");
    if (result.status === "failed") {
      assert.equal(result.error.code, "pi-rpc");
      assert.match(result.error.message, /rejected the marker/);
    }
  } finally {
    await runtime.dispose();
    await backend.dispose();
    modelRegistry.unregisterProvider(PROVIDER);
  }
});

test("RPC backend fails closed on malformed JSONL from the child", async () => {
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

  const backend = new PiRpcBackend({
    modelRegistry,
    cwd: process.cwd(),
    invocationFactory: () => ({
      command: process.execPath,
      args: [
        "--input-type=module",
        "-e",
        'process.stdout.write("this is not json\\n"); setInterval(() => undefined, 1000);',
      ],
    }),
  });
  const runtime = createExecutionRuntime();
  runtime.registerBackend(backend);

  try {
    const prepared = await runtime.prepare({
      backendId: PI_RPC_READONLY_BACKEND_ID,
      intent: fixtureIntent(),
      compile: async () => fixtureConversation(),
    });
    const run = runtime.execute(prepared);
    const result = await run.result;
    assert.equal(result.status, "failed");
    if (result.status === "failed") {
      assert.match(result.error.message, /malformed JSON/);
    }
  } finally {
    await runtime.dispose();
    await backend.dispose();
    modelRegistry.unregisterProvider(PROVIDER);
  }
});

test("subprocess and RPC backends seal the same conversation with different execution fingerprints", async () => {
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

  const subprocess = new PiSubprocessBackend({
    modelRegistry,
    cwd: process.cwd(),
  });
  const rpc = new PiRpcBackend({ modelRegistry, cwd: process.cwd() });
  const runtime = createExecutionRuntime();
  runtime.registerBackend(subprocess);
  runtime.registerBackend(rpc);

  try {
    const compile = async () => fixtureConversation();
    const subprocessPrepared = await runtime.prepare({
      backendId: subprocess.descriptor.id,
      intent: fixtureIntent(),
      compile,
    });
    const rpcPrepared = await runtime.prepare({
      backendId: PI_RPC_READONLY_BACKEND_ID,
      intent: fixtureIntent(),
      compile,
    });
    const subprocessPlan = subprocessPrepared.snapshot();
    const rpcPlan = rpcPrepared.snapshot();

    assert.equal(
      rpcPlan.conversationFingerprint,
      subprocessPlan.conversationFingerprint,
      "both backends must seal the identical compiled conversation",
    );
    assert.notEqual(
      rpcPlan.executionFingerprint,
      subprocessPlan.executionFingerprint,
      "execution fingerprints bind the accepted backend and preflight",
    );
    assert.deepEqual(
      rpcPlan.effectiveTools.map((tool) => tool.backendToolName),
      subprocessPlan.effectiveTools.map((tool) => tool.backendToolName),
    );
    assert.deepEqual(
      rpcPlan.promptRuntime.options.selectedTools,
      subprocessPlan.promptRuntime.options.selectedTools,
    );
    assert.equal(
      rpcPlan.promptRuntime.baseSystemPrompt,
      subprocessPlan.promptRuntime.baseSystemPrompt,
    );

    await subprocessPrepared.discard();
    await rpcPrepared.discard();
  } finally {
    await runtime.dispose();
    await subprocess.dispose();
    await rpc.dispose();
    modelRegistry.unregisterProvider(PROVIDER);
  }
  assert.deepEqual(subprocessTempDirectories(), tempDirectoriesBefore);
});

test("RPC backend passes the reusable conformance suite", async () => {
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

  const backend = new PiRpcBackend({
    modelRegistry,
    cwd: process.cwd(),
    invocationFactory: () => ({
      command: process.execPath,
      args: ["--input-type=module", "-e", scriptedRpcChildScript()],
    }),
  });
  try {
    const report = await runBackendConformance({
      backend,
      intent: () => fixtureIntent(),
      compile: async () => fixtureConversation(),
    });
    assert.equal(report.backendId, PI_RPC_READONLY_BACKEND_ID);
    assert.equal(report.result.status, "completed");
    assert.ok(report.eventCount >= 1);
  } finally {
    await backend.dispose();
    modelRegistry.unregisterProvider(PROVIDER);
  }
});

/**
 * A scripted stand-in for `pi --mode rpc`. It implements the strict-LF
 * JSONL protocol, answers the marker prompt with a fixture event sequence,
 * writes the same sanitized fd3 report lines the trusted bridge would
 * write, and optionally honors or ignores the abort command.
 */
function scriptedRpcChildScript(
  options: {
    rejectPrompt?: boolean;
    honorAbort?: boolean;
    sigtermDelayMs?: number;
  } = {},
): string {
  const fd3Events = fixtureFd3Events();
  const rpcEvents = fixtureRpcEvents();
  return `
const { writeSync } = await import("node:fs");
let buffer = "";
const send = (record) => process.stdout.write(JSON.stringify(record) + "\\n");
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let index;
  while ((index = buffer.indexOf("\\n")) !== -1) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;
    const command = JSON.parse(line);
    if (command.type === "prompt") {
      if (${options.rejectPrompt === true}) {
        send({ type: "response", command: "prompt", id: command.id, success: false, error: "rejected the marker prompt" });
        continue;
      }
      send({ type: "response", command: "prompt", id: command.id, success: true });
      for (const event of ${JSON.stringify(rpcEvents)}) send(event);
      for (const event of ${JSON.stringify(fd3Events)}) writeSync(3, JSON.stringify(event) + "\\n");
      if (${options.honorAbort !== false}) {
        send({ type: "agent_end", messages: [], willRetry: false });
        send({ type: "agent_settled" });
      } else {
        setInterval(() => undefined, 1_000);
      }
    } else if (command.type === "abort") {
      send({ type: "response", command: "abort", id: command.id, success: true });
      if (${options.honorAbort !== false}) {
        send({ type: "agent_end", messages: [], willRetry: false });
        send({ type: "agent_settled" });
      }
    }
  }
});
process.on("SIGTERM", () => setTimeout(() => process.exit(0), ${options.sigtermDelayMs ?? 0}));
process.stdin.on("end", () => setTimeout(() => process.exit(0), 20));
`;
}

function fixtureRpcEvents(): unknown[] {
  return [
    { type: "agent_start" },
    { type: "turn_start" },
    {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "RPC started." }],
        api: API,
        provider: PROVIDER,
        model: MODEL_ID,
        usage: {
          input: 0,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 1,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "toolUse",
        timestamp: 1,
      },
    },
    {
      type: "message_end",
      message: {
        role: "toolResult",
        toolCallId: "tool-1",
        toolName: "read",
        content: [{ type: "text", text: "fixture source" }],
        isError: false,
        timestamp: 2,
      },
    },
  ];
}

function fixtureFd3Events(): unknown[] {
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
        isError: false,
        timestamp: 2,
      },
    },
    {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Fixture RPC complete." }],
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
        timestamp: 3,
      },
    },
  ];
}

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
    systemPrompt: "You are the Fixture RPC reviewer.",
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "Inspect the fixture workspace." }],
      },
    ],
  };
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
        name.startsWith("pi-subagent-runtime-rpc-prepare-") ||
        name.startsWith("pi-subagent-runtime-rpc-"),
    )
    .sort();
}
