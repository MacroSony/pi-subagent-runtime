import assert from "node:assert/strict";
import test from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";

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
        ...(typeof context.systemPrompt === "string"
          ? { systemPrompt: context.systemPrompt }
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
    assert.equal(backend.takeReport(prepared.id), undefined);
  } finally {
    await runtime.dispose();
    await backend.dispose();
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
