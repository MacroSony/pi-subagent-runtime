import assert from "node:assert/strict";
import test from "node:test";
import { AgentSession } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";

import { createFixturePiRuntime } from "./helpers/fixture-pi-runtime.ts";
import type { ExecutionIntent, PreparedConversation } from "../src/core/index.ts";
import { createExecutionRuntime } from "../src/runtime/index.ts";
import {
  PI_INPROCESS_BACKEND_ID,
  PiInProcessBackend,
} from "../src/backends/inprocess/index.ts";

const PROVIDER = "pi-subagent-runtime-cleanup-usage-fixture";
const MODEL_ID = "fixture-model";
const API = "pi-subagent-runtime-cleanup-usage-api";

function intent(): ExecutionIntent {
  return {
    model: { provider: PROVIDER, id: MODEL_ID },
    thinkingLevel: "high",
    requestedTools: [],
    access: {
      level: "read-only",
      executionBoundary: "shared-user",
      workspaces: [{ handle: "project", mode: "read-only" }],
      workingDirectory: { workspaceHandle: "project", path: "." },
      network: "allow",
      allowProcess: false,
    },
    limits: { timeoutMs: { value: 30_000, enforcement: "best-effort" } },
  };
}

function conversation(): PreparedConversation {
  return {
    systemPrompt: "You are the cleanup-usage fixture worker.",
    messages: [{ role: "user", content: [{ type: "text", text: "Answer once." }] }],
  };
}

test("in-process cleanup failure keeps the usage of provider requests that already happened", async () => {
  let providerCalls = 0;
  const { faux, modelRegistry } = await createFixturePiRuntime({
    provider: PROVIDER,
    api: API,
    modelId: MODEL_ID,
  });
  faux.setResponses([
    () => {
      providerCalls += 1;
      return fauxAssistantMessage("Answer before cleanup failure.");
    },
  ]);
  const backend = new PiInProcessBackend({ modelRegistry, cwd: process.cwd() });
  const runtime = createExecutionRuntime();
  runtime.registerBackend(backend);
  const originalDispose = AgentSession.prototype.dispose;
  let disposeCalls = 0;
  try {
    const prepared = await runtime.prepare({
      backendId: PI_INPROCESS_BACKEND_ID,
      intent: intent(),
      compile: async () => conversation(),
    });
    AgentSession.prototype.dispose = function (this: AgentSession): void {
      disposeCalls += 1;
      if (disposeCalls === 1) throw new Error("injected cleanup failure");
      return originalDispose.call(this);
    };
    const result = await runtime.execute(prepared).result;

    assert.equal(providerCalls, 1);
    assert.equal(result.status, "failed");
    if (result.status !== "failed") return;
    assert.equal(result.error.code, "inprocess-cleanup");
    assert.equal(result.error.retryable, false);
    assert.deepEqual(result.usage?.requests, { total: 1, cacheKnown: 1, usageKnown: 1 });
    assert.ok((result.usage?.tokens?.total ?? 0) > 0);
    assert.equal(result.output?.text, "Answer before cleanup failure.");
    assert.equal(result.output?.partial, true);

    const report = backend.takeReport(prepared.id);
    assert.ok(report);
    assert.equal(report.status, "failed");
    assert.equal(report.usage.turns, 1);
  } finally {
    AgentSession.prototype.dispose = originalDispose;
    await runtime.dispose().catch(() => undefined);
    await backend.dispose().catch(() => undefined);
  }
});

test("a later runtime.dispose() retries backend cleanup that failed during the first dispose", async () => {
  const { faux, modelRegistry } = await createFixturePiRuntime({
    provider: PROVIDER,
    api: API,
    modelId: MODEL_ID,
  });
  faux.setResponses([fauxAssistantMessage("retained child")]);
  const backend = new PiInProcessBackend({ modelRegistry, cwd: process.cwd() });
  const runtime = createExecutionRuntime();
  runtime.registerBackend(backend);
  const originalDispose = AgentSession.prototype.dispose;
  let disposeCalls = 0;
  try {
    const prepared = await runtime.prepare({
      backendId: PI_INPROCESS_BACKEND_ID,
      intent: { ...intent(), continuation: { retain: true } },
      compile: async () => conversation(),
    });
    const result = await runtime.execute(prepared).result;
    assert.equal(result.status, "completed");
    AgentSession.prototype.dispose = function (this: AgentSession): void {
      disposeCalls += 1;
      if (disposeCalls === 1) throw new Error("injected retained stop failure");
      return originalDispose.call(this);
    };

    await assert.rejects(() => runtime.dispose(), /Runtime disposal encountered cleanup failures/);
    assert.equal(disposeCalls, 1);
    // The retry goes back to the backend that failed; the retained child is
    // actually released this time.
    await runtime.dispose();
    assert.equal(disposeCalls, 2);
    // After a successful retry, dispose() is settled and idempotent.
    await runtime.dispose();
    assert.equal(disposeCalls, 2);
  } finally {
    AgentSession.prototype.dispose = originalDispose;
    await runtime.dispose().catch(() => undefined);
    await backend.dispose().catch(() => undefined);
    modelRegistry.unregisterProvider(PROVIDER);
  }
});
