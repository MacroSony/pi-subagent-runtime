import { getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import assert from "node:assert/strict";
import test from "node:test";
import { AgentSession } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";

import { createFixturePiRuntime } from "./helpers/fixture-pi-runtime.ts";
import type {
  ExecutionIntent,
  PreparedConversation,
  PromptRuntime,
  RunEvent,
} from "../src/core/index.ts";
import { createExecutionRuntime } from "../src/runtime/index.ts";
import {
  PI_INPROCESS_BACKEND_ID,
  PI_INPROCESS_TOOL_CATALOG,
  PiInProcessBackend,
} from "../src/backends/inprocess/index.ts";

const PROVIDER = "pi-subagent-runtime-inprocess-fixture";
const MODEL_ID = "fixture-model";
const API = "pi-subagent-runtime-inprocess-api";

function fixtureIntent(overrides: Partial<ExecutionIntent> = {}): ExecutionIntent {
  return {
    model: { provider: PROVIDER, id: MODEL_ID },
    thinkingLevel: "high",
    requestedTools: ["read", "grep", "find", "ls", "edit", "write", "bash"],
    access: {
      level: "workspace-write",
      executionBoundary: "shared-user",
      workspaces: [{ handle: "project", mode: "read-write" }],
      workingDirectory: { workspaceHandle: "project", path: "." },
      network: "allow",
      allowProcess: true,
    },
    limits: { timeoutMs: { value: 30_000, enforcement: "best-effort" } },
    ...overrides,
  };
}

function fixtureConversation(): PreparedConversation {
  return {
    systemPrompt: "You are the Fixture in-process worker.",
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "Do the fixture task." }],
      },
    ],
  };
}

test("in-process backend resumes the primed session against an extension-registered provider", async () => {
  const providerContexts: Array<{ systemPrompt?: string; messageCount: number }> = [];
  const { faux, modelRegistry } = await createFixturePiRuntime({
    provider: PROVIDER,
    api: API,
    modelId: MODEL_ID,
  });
  faux.setResponses([
    (context) => {
      // Context carries tool execute functions and is not structuredClone-able.
      providerContexts.push({
        ...(typeof getCurrentSystemPrompt(context.messages) === "string"
          ? { systemPrompt: getCurrentSystemPrompt(context.messages) }
          : {}),
        messageCount: context.messages?.length ?? 0,
      });
      return fauxAssistantMessage("In-process fixture complete.");
    },
  ]);

  const backend = new PiInProcessBackend({
    modelRegistry,
    cwd: process.cwd(),
  });
  const runtime = createExecutionRuntime();
  runtime.registerBackend(backend);

  try {
    let compiledRuntime: PromptRuntime | undefined;
    const prepared = await runtime.prepare({
      backendId: PI_INPROCESS_BACKEND_ID,
      intent: fixtureIntent(),
      compile: async (promptRuntime) => {
        compiledRuntime = promptRuntime;
        return fixtureConversation();
      },
    });
    // Preparation parks before provider transport.
    assert.equal(providerContexts.length, 0);
    assert.ok(compiledRuntime);
    assert.equal(compiledRuntime!.fidelity, "backend-assisted");
    assert.equal(compiledRuntime!.model.provider, PROVIDER);

    const plan = prepared.snapshot();
    assert.equal(plan.backendId, PI_INPROCESS_BACKEND_ID);
    assert.equal(plan.preflight.access.level, "workspace-write");
    assert.equal(plan.preflight.access.executionBoundary, "shared-user");
    assert.equal(plan.preflight.access.process, true);
    assert.equal(plan.preflight.access.enforcement.readWriteMountIsolation, false);
    assert.equal(plan.preflight.access.enforcement.processIsolation, false);
    assert.deepEqual(
      plan.preflight.toolCatalog.map((tool) => tool.name),
      PI_INPROCESS_TOOL_CATALOG.map((tool) => tool.name),
    );
    assert.ok(
      plan.preflight.diagnostics.some(
        (item) => item.code === "pi-inprocess.shared-user",
      ),
    );

    const runEvents: RunEvent[] = [];
    const run = runtime.execute(prepared);
    run.subscribe((event) => runEvents.push(event));
    const result = await run.result;

    assert.equal(result.status, "completed");
    if (result.status !== "completed") return;
    assert.equal(result.output.text, "In-process fixture complete.");
    assert.equal(result.output.partial, false);
    // The execution went through the host model runtime with the sealed
    // conversation — the extension-registered faux provider was called once.
    assert.equal(providerContexts.length, 1);
    assert.equal(
      providerContexts[0]!.systemPrompt,
      fixtureConversation().systemPrompt,
    );
    assert.ok(
      runEvents.some(
        (event) =>
          event.phase === "finishing" && event.message === "Subagent report ready.",
      ),
    );

    const report = backend.takeReport(prepared.id);
    assert.ok(report);
    assert.equal(report.status, "completed");
    assert.equal(report.executionBoundary, "shared-user");
    assert.equal(report.executionFingerprint, plan.executionFingerprint);
    assert.equal(report.usage.turns, 1);
    assert.equal(report.usage.cacheKnownTurns, 1);
    assert.deepEqual(result.usage?.requests, {
      total: 1,
      cacheKnown: 1,
      usageKnown: 1,
    });
    assert.equal(backend.takeReport(prepared.id), undefined);
  } finally {
    await runtime.dispose();
    await backend.dispose();
    modelRegistry.unregisterProvider(PROVIDER);
  }
});

test("in-process multi-turn runs keep the sealed conversation and never leak the preparation trigger", async () => {
  const observedContexts: Array<{ userTexts: string[]; hasToolResult: boolean }> = [];
  const { faux, modelRegistry } = await createFixturePiRuntime({
    provider: PROVIDER,
    api: API,
    modelId: MODEL_ID,
  });
  faux.setResponses([
    // Turn 1: request a real tool call so the agent loop takes a second turn.
    fauxAssistantMessage(fauxToolCall("read", { path: "package.json" })),
    // Turn 2: record the provider-visible context, then finish.
    (context) => {
      const messages = context.messages ?? [];
      const userTexts: string[] = [];
      let hasToolResult = false;
      for (const message of messages) {
        if (message.role === "user") {
          const content = message.content;
          if (typeof content === "string") userTexts.push(content);
          else if (Array.isArray(content)) {
            for (const part of content) {
              if (part?.type === "text" && typeof part.text === "string") {
                userTexts.push(part.text);
              }
            }
          }
        }
        if (message.role === "toolResult") hasToolResult = true;
      }
      observedContexts.push({ userTexts, hasToolResult });
      return fauxAssistantMessage("Multi-turn fixture complete.");
    },
  ]);

  const backend = new PiInProcessBackend({
    modelRegistry,
    cwd: process.cwd(),
  });
  const runtime = createExecutionRuntime();
  runtime.registerBackend(backend);

  try {
    const prepared = await runtime.prepare({
      backendId: PI_INPROCESS_BACKEND_ID,
      intent: fixtureIntent(),
      compile: async () => fixtureConversation(),
    });
    const result = await runtime.execute(prepared).result;
    assert.equal(result.status, "completed");
    if (result.status !== "completed") return;
    assert.equal(result.output.text, "Multi-turn fixture complete.");

    // The second provider request must still carry the sealed task, must show
    // the accumulated tool result, and must not contain the trigger prompt.
    assert.equal(observedContexts.length, 1);
    const observed = observedContexts[0]!;
    assert.ok(
      observed.userTexts.some((text) => text.includes("Do the fixture task.")),
      "sealed task missing from the turn-2 provider context",
    );
    assert.ok(
      observed.hasToolResult,
      "accumulated tool result missing from the turn-2 provider context",
    );
    assert.ok(
      observed.userTexts.every(
        (text) =>
          !text.includes(
            "Prepare the subagent prompt runtime without contacting the provider.",
          ),
      ),
      "preparation trigger leaked into the provider context",
    );
  } finally {
    await runtime.dispose();
    await backend.dispose();
    modelRegistry.unregisterProvider(PROVIDER);
  }
});

test("in-process continuation reuses the same session, reauthorizes full history, and releases explicitly", async () => {
  const providerContexts: Array<{ system: string; messages: unknown[] }> = [];
  const { faux, modelRegistry } = await createFixturePiRuntime({
    provider: PROVIDER,
    api: API,
    modelId: MODEL_ID,
  });
  faux.setResponses([
    (context) => {
      providerContexts.push({ system: getCurrentSystemPrompt(context.messages) ?? "", messages: structuredClone(context.messages ?? []) });
      return fauxAssistantMessage(fauxToolCall("read", { path: "package.json" }));
    },
    (context) => {
      providerContexts.push({ system: getCurrentSystemPrompt(context.messages) ?? "", messages: structuredClone(context.messages ?? []) });
      return fauxAssistantMessage("First answer with SECRET_MARKER and tool history.");
    },
    (context) => {
      providerContexts.push({ system: getCurrentSystemPrompt(context.messages) ?? "", messages: structuredClone(context.messages ?? []) });
      return fauxAssistantMessage("Second answer.");
    },
    (context) => {
      providerContexts.push({ system: getCurrentSystemPrompt(context.messages) ?? "", messages: structuredClone(context.messages ?? []) });
      return fauxAssistantMessage("After discard.");
    },
  ]);
  const backend = new PiInProcessBackend({ modelRegistry, cwd: process.cwd() });
  const runtime = createExecutionRuntime();
  runtime.registerBackend(backend);
  try {
    const first = await runtime.prepare({
      backendId: PI_INPROCESS_BACKEND_ID,
      intent: fixtureIntent({ continuation: { retain: true } }),
      compile: async () => fixtureConversation(),
    });
    assert.equal(providerContexts.length, 0);
    const firstResult = await runtime.execute(first).result;
    assert.equal(firstResult.status, "completed");
    assert.ok(firstResult.continuationId);
    const continuationId = firstResult.continuationId!;

    let approvedHistory: PreparedConversation | undefined;
    const second = await runtime.prepare({
      backendId: PI_INPROCESS_BACKEND_ID,
      intent: fixtureIntent({ continuation: { retain: true, id: continuationId } }),
      compile: async (_runtime, _preflight, continuation) => {
        approvedHistory = continuation?.history;
        assert.ok(approvedHistory);
        return {
          systemPrompt: approvedHistory!.systemPrompt,
          messages: [
            ...approvedHistory!.messages,
            { role: "user", content: [{ type: "text", text: "Continue with the approved context." }] },
          ],
        };
      },
    });
    assert.equal(providerContexts.length, 2, "approval must not contact provider");
    assert.ok(second.snapshot().conversation.messages.length > first.snapshot().conversation.messages.length);
    const secondResult = await runtime.execute(second).result;
    assert.equal(secondResult.status, "completed");
    assert.equal(secondResult.continuationId, continuationId);
    assert.equal(providerContexts.length, 3);
    assert.equal(providerContexts[2]!.system, fixtureConversation().systemPrompt);
    const visible = JSON.stringify(providerContexts[2]!.messages);
    assert.match(visible, /Do the fixture task/);
    assert.match(visible, /SECRET_MARKER/);
    assert.match(visible, /toolResult/);
    assert.match(visible, /Continue with the approved context/);
    assert.doesNotMatch(visible, /Prepare the subagent prompt runtime without contacting the provider/);
    assert.deepEqual(secondResult.usage?.requests, { total: 1, cacheKnown: 1, usageKnown: 1 });

    const disposable = await runtime.prepare({
      backendId: PI_INPROCESS_BACKEND_ID,
      intent: fixtureIntent({ continuation: { retain: true, id: continuationId } }),
      compile: async (_runtime, _preflight, continuation) => ({
        systemPrompt: continuation!.history.systemPrompt,
        messages: [...continuation!.history.messages, {
          role: "user", content: [{ type: "text", text: "Discard this task." }],
        }],
      }),
    });
    await assert.rejects(() => runtime.prepare({
      backendId: PI_INPROCESS_BACKEND_ID,
      intent: fixtureIntent({ continuation: { retain: true, id: continuationId } }),
      compile: async () => { throw new Error("locked continuation must not compile"); },
    }));
    await disposable.discard();
    const afterDiscard = await runtime.prepare({
      backendId: PI_INPROCESS_BACKEND_ID,
      intent: fixtureIntent({ continuation: { retain: true, id: continuationId } }),
      compile: async (_runtime, _preflight, continuation) => ({
        systemPrompt: continuation!.history.systemPrompt,
        messages: [...continuation!.history.messages, {
          role: "user", content: [{ type: "text", text: "Continue after discard." }],
        }],
      }),
    });
    assert.equal((await runtime.execute(afterDiscard).result).status, "completed");
    assert.equal(providerContexts.length, 4);

    await runtime.releaseContinuation(continuationId);
    const denied = await runtime.prepare({
      backendId: PI_INPROCESS_BACKEND_ID,
      intent: fixtureIntent({ continuation: { retain: true, id: continuationId } }),
      compile: async () => { throw new Error("released continuation must not compile"); },
    }).then(() => false, () => true);
    assert.equal(denied, true);
  } finally {
    await runtime.dispose();
    await backend.dispose();
    modelRegistry.unregisterProvider(PROVIDER);
  }
});

test("in-process cleanup retries a failed retained stop and attempts other children", async () => {
  const { faux, modelRegistry } = await createFixturePiRuntime({
    provider: PROVIDER,
    api: API,
    modelId: MODEL_ID,
  });
  faux.setResponses([
    fauxAssistantMessage("first retained child"),
    fauxAssistantMessage("second retained child"),
  ]);
  const backend = new PiInProcessBackend({ modelRegistry, cwd: process.cwd() });
  const runtime = createExecutionRuntime();
  runtime.registerBackend(backend);
  const originalDispose = AgentSession.prototype.dispose;
  let disposeCalls = 0;
  AgentSession.prototype.dispose = function (): void {
    disposeCalls += 1;
    if (disposeCalls === 1) throw new Error("injected retained stop failure");
    originalDispose.call(this);
  };
  try {
    const retainedIds: string[] = [];
    for (let index = 0; index < 2; index += 1) {
      const prepared = await runtime.prepare({
        backendId: PI_INPROCESS_BACKEND_ID,
        intent: fixtureIntent({ continuation: { retain: true } }),
        compile: async () => fixtureConversation(),
      });
      const result = await runtime.execute(prepared).result;
      assert.equal(result.status, "completed");
      if (result.status !== "completed") return;
      retainedIds.push(result.continuationId!);
    }
    assert.equal(retainedIds.length, 2);

    await assert.rejects(
      () => backend.dispose(),
      /In-process backend cleanup encountered failures/,
    );
    // The first child failed, but the second child was still attempted. The
    // failed owner remains for the next bounded cleanup call.
    assert.equal(disposeCalls, 2);
    await backend.dispose();
    assert.equal(disposeCalls, 3);
  } finally {
    AgentSession.prototype.dispose = originalDispose;
    await runtime.dispose().catch(() => undefined);
    await backend.dispose().catch(() => undefined);
    modelRegistry.unregisterProvider(PROVIDER);
  }
});

test("runtime retains a continuation owner after an explicit release failure", async () => {
  const { faux, modelRegistry } = await createFixturePiRuntime({
    provider: PROVIDER,
    api: API,
    modelId: MODEL_ID,
  });
  faux.setResponses([fauxAssistantMessage("retained for retry")]);
  const backend = new PiInProcessBackend({ modelRegistry, cwd: process.cwd() });
  const runtime = createExecutionRuntime();
  const registration = runtime.registerBackend(backend);
  const originalDispose = AgentSession.prototype.dispose;
  let disposeCalls = 0;
  AgentSession.prototype.dispose = function (): void {
    disposeCalls += 1;
    if (disposeCalls === 1) throw new Error("injected explicit stop failure");
    originalDispose.call(this);
  };
  try {
    const prepared = await runtime.prepare({
      backendId: PI_INPROCESS_BACKEND_ID,
      intent: fixtureIntent({ continuation: { retain: true } }),
      compile: async () => fixtureConversation(),
    });
    const result = await runtime.execute(prepared).result;
    assert.equal(result.status, "completed");
    if (result.status !== "completed") return;

    await assert.rejects(
      () =>
        Promise.all([
          runtime.releaseContinuation(result.continuationId!),
          runtime.releaseContinuation(result.continuationId!),
        ]),
      /Pi preparation cleanup failed/,
    );
    // Concurrent release calls share one bounded stop attempt.
    assert.equal(disposeCalls, 1);
    // Remove the backend from discovery: a second successful release proves
    // the runtime kept the owner map entry after the failed await.
    registration.dispose();
    await runtime.releaseContinuation(result.continuationId!);
    assert.equal(disposeCalls, 2);
  } finally {
    AgentSession.prototype.dispose = originalDispose;
    await runtime.dispose().catch(() => undefined);
    await backend.dispose().catch(() => undefined);
    modelRegistry.unregisterProvider(PROVIDER);
  }
});

test("in-process backend cancels a running execution", async () => {
  const { faux, modelRegistry } = await createFixturePiRuntime({
    provider: PROVIDER,
    api: API,
    modelId: MODEL_ID,
  });
  faux.setResponses([
    (_context, options) =>
      new Promise<ReturnType<typeof fauxAssistantMessage>>((_resolve, reject) => {
        // Never completes on its own; cancellation must abort the session,
        // and pi aborts in-flight provider streams through this signal.
        options?.signal?.addEventListener("abort", () =>
          reject(new Error("aborted")),
        );
      }),
  ]);

  const backend = new PiInProcessBackend({
    modelRegistry,
    cwd: process.cwd(),
  });
  const runtime = createExecutionRuntime();
  runtime.registerBackend(backend);

  try {
    const prepared = await runtime.prepare({
      backendId: PI_INPROCESS_BACKEND_ID,
      intent: fixtureIntent(),
      compile: async () => fixtureConversation(),
    });
    const run = runtime.execute(prepared);
    await new Promise((resolve) => setTimeout(resolve, 250));
    await run.cancel("test cancellation");
    const result = await run.result;
    assert.equal(result.status, "cancelled");
    if (result.status === "cancelled") {
      assert.equal(result.reason, "test cancellation");
    }
  } finally {
    await runtime.dispose();
    await backend.dispose();
    modelRegistry.unregisterProvider(PROVIDER);
  }
});

test("in-process backend refuses isolated boundaries and dishonest network policy", async () => {
  const { modelRegistry } = await createFixturePiRuntime({
    provider: PROVIDER,
    api: API,
    modelId: MODEL_ID,
  });
  const backend = new PiInProcessBackend({
    modelRegistry,
    cwd: process.cwd(),
  });
  try {
    const isolated = await backend.preflight({
      intent: fixtureIntent({
        access: { ...fixtureIntent().access, executionBoundary: "isolated" },
      }),
      signal: new AbortController().signal,
    });
    assert.equal(isolated.status, "rejected");
    assert.ok(
      isolated.diagnostics.some(
        (diagnostic) => diagnostic.code === "pi-inprocess.boundary",
      ),
    );

    const denied = await backend.preflight({
      intent: fixtureIntent({
        access: { ...fixtureIntent().access, network: "deny" },
      }),
      signal: new AbortController().signal,
    });
    assert.equal(denied.status, "rejected");
    assert.ok(
      denied.diagnostics.some(
        (diagnostic) => diagnostic.code === "pi-inprocess.network",
      ),
    );
  } finally {
    await backend.dispose();
    modelRegistry.unregisterProvider(PROVIDER);
  }
});


test("retained SDK children disable automatic compaction without saving settings", async () => {
  const { faux, modelRegistry } = await createFixturePiRuntime({ provider: PROVIDER, api: API, modelId: MODEL_ID });
  faux.setResponses([fauxAssistantMessage("retained")]);
  const original = AgentSession.prototype.prompt;
  let observed = false;
  AgentSession.prototype.prompt = function (...args) {
    observed = true;
    assert.equal(this.autoCompactionEnabled, false);
    return original.apply(this, args);
  };
  const runtime = createExecutionRuntime();
  runtime.registerBackend(new PiInProcessBackend({ modelRegistry, cwd: process.cwd() }));
  try {
    const prepared = await runtime.prepare({ backendId: PI_INPROCESS_BACKEND_ID,
      intent: fixtureIntent({ continuation: { retain: true } }), compile: async () => fixtureConversation() });
    assert.equal((await runtime.execute(prepared).result).status, "completed");
    assert.equal(observed, true);
  } finally {
    AgentSession.prototype.prompt = original;
    await runtime.dispose();
    modelRegistry.unregisterProvider(PROVIDER);
  }
});
