import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExecutionIntent, PreparedConversation } from "../src/core/index.ts";
import { createExecutionRuntime } from "../src/runtime/index.ts";
import { PiSubprocessBackend } from "../src/backends/subprocess/pi-subprocess-backend.ts";
import { PiRpcBackend } from "../src/backends/rpc/pi-rpc-backend.ts";
import { createFixturePiRuntime } from "./helpers/fixture-pi-runtime.ts";
import {
  createPiInvocationFactory,
  normalizeProviderPayload,
  resolvePiCli,
  startMockProvider,
  writeFixtureModelsJson,
} from "./helpers/pi-e2e-fixture.ts";

/**
 * End-to-end fidelity spike: both process backends drive a REAL pi child
 * (text mode and RPC mode) with the real trusted bridge against a local
 * mock provider, and the provider-visible payloads must match the sealed
 * conversation exactly. Skipped when no pi CLI is available.
 */

const PROVIDER = "pi-runtime-e2e";
const MODEL_ID = "fixture-model";

const PI_CLI = resolvePiCli();

test(
  "real pi children in text and RPC modes deliver the identical sealed conversation to the provider",
  { skip: PI_CLI === undefined ? "pi CLI is not available" : false, timeout: 120_000 },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-subagent-runtime-e2e-"));
    const agentDir = join(root, "agent");
    const workDir = join(root, "work");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(workDir, { recursive: true });

    const providerPayloads: Record<string, unknown>[] = [];
    const server = await startMockProvider(providerPayloads, { modelId: MODEL_ID });
    const port = (server.address() as { port: number }).port;
    writeFixtureModelsJson(agentDir, { provider: PROVIDER, modelId: MODEL_ID, port });

    const invocationFactory = createPiInvocationFactory(PI_CLI!);
    const env = { PI_CODING_AGENT_DIR: agentDir };

    const { faux, modelRegistry } = await createFixturePiRuntime({
      provider: PROVIDER,
      api: "pi-runtime-e2e-api",
      modelId: MODEL_ID,
      modelName: "Fixture E2E model",
    });
    faux.setResponses([
      () => {
        throw new Error("dry preparation must not reach this provider");
      },
    ]);

    const subprocess = new PiSubprocessBackend({
      modelRegistry,
      cwd: workDir,
      invocationFactory,
      env,
    });
    const rpc = new PiRpcBackend({
      modelRegistry,
      cwd: workDir,
      invocationFactory,
      env,
    });
    const runtime = createExecutionRuntime();
    runtime.registerBackend(subprocess);
    runtime.registerBackend(rpc);

    try {
      const conversation = fixtureConversation();
      const compile = async () => conversation;

      const subprocessPrepared = await runtime.prepare({
        backendId: subprocess.descriptor.id,
        intent: fixtureIntent(),
        compile,
      });
      const rpcPrepared = await runtime.prepare({
        backendId: rpc.descriptor.id,
        intent: fixtureIntent(),
        compile,
      });
      assert.equal(
        rpcPrepared.conversationFingerprint,
        subprocessPrepared.conversationFingerprint,
      );
      assert.notEqual(
        rpcPrepared.executionFingerprint,
        subprocessPrepared.executionFingerprint,
      );

      const subprocessResult = await runtime.execute(subprocessPrepared).result;
      assert.equal(
        subprocessResult.status,
        "completed",
        JSON.stringify(subprocessResult),
      );
      const rpcResult = await runtime.execute(rpcPrepared).result;
      assert.equal(rpcResult.status, "completed", JSON.stringify(rpcResult));

      assert.equal(providerPayloads.length, 2, "both children must reach the mock provider");
      const [subprocessPayload, rpcPayload] = providerPayloads.map(normalizeProviderPayload);
      assert.ok(subprocessPayload && rpcPayload);
      assert.deepEqual(rpcPayload, subprocessPayload);
      assert.equal(subprocessPayload.system, conversation.systemPrompt);
      assert.deepEqual(subprocessPayload.orderedContents, [
        "First prepared instruction.",
        "Prepared prior answer.",
        "Final prepared instruction.",
      ]);
      assert.deepEqual(subprocessPayload.tools, ["read", "grep", "find", "ls"]);
      assert.ok(
        !JSON.stringify(providerPayloads).includes("PI_SUBAGENT_RUNTIME_MARKER_"),
        "the unique marker must never reach the provider",
      );

      if (subprocessResult.status === "completed") {
        assert.equal(subprocessResult.output.text, "E2E complete.");
      }
      if (rpcResult.status === "completed") {
        assert.equal(rpcResult.output.text, "E2E complete.");
      }
      assert.equal(subprocess.takeReport(subprocessPrepared.id)?.status, "completed");
      assert.equal(rpc.takeReport(rpcPrepared.id)?.status, "completed");
    } finally {
      await runtime.dispose();
      await subprocess.dispose();
      await rpc.dispose();
      modelRegistry.unregisterProvider(PROVIDER);
      server.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

function fixtureIntent(): ExecutionIntent {
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
    limits: { timeoutMs: { value: 60_000, enforcement: "best-effort" } },
  };
}

function fixtureConversation(): PreparedConversation {
  return {
    systemPrompt: "You are the exact E2E reviewer.",
    messages: [
      { role: "user", content: [{ type: "text", text: "First prepared instruction." }] },
      { role: "assistant", content: [{ type: "text", text: "Prepared prior answer." }] },
      { role: "user", content: [{ type: "text", text: "Final prepared instruction." }] },
    ],
  };
}
