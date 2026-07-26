import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import type { Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { createFauxCore, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ExecutionIntent, PreparedConversation } from "../src/core/index.ts";
import { createExecutionRuntime } from "../src/runtime/index.ts";
import { PiSubprocessBackend } from "../src/backends/subprocess/pi-subprocess-backend.ts";
import { PiRpcBackend } from "../src/backends/rpc/pi-rpc-backend.ts";

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
    const server = await startMockProvider(providerPayloads);
    const port = (server.address() as { port: number }).port;
    writeFileSync(
      join(agentDir, "models.json"),
      JSON.stringify({
        providers: {
          [PROVIDER]: {
            baseUrl: `http://127.0.0.1:${port}/v1`,
            api: "openai-completions",
            apiKey: "fixture",
            compat: {
              supportsDeveloperRole: false,
              supportsReasoningEffort: false,
            },
            models: [
              {
                id: MODEL_ID,
                name: "Fixture E2E model",
                reasoning: true,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 32_000,
                maxTokens: 4_000,
              },
            ],
          },
        },
      }),
    );

    const invocationFactory = (piArgs: string[]) =>
      PI_CLI!.endsWith(".js")
        ? { command: process.execPath, args: [PI_CLI!, ...piArgs] }
        : { command: PI_CLI!, args: piArgs };
    const env = { PI_CODING_AGENT_DIR: agentDir };

    const faux = createFauxCore({
      api: "pi-runtime-e2e-api",
      provider: PROVIDER,
      models: [{ id: MODEL_ID, name: "Fixture", reasoning: true }],
    });
    faux.setResponses([
      () => {
        throw new Error("dry preparation must not reach this provider");
      },
    ]);
    const { modelRegistry } = await fixtureModelRuntime(faux);

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
      const [subprocessPayload, rpcPayload] = providerPayloads.map(normalizePayload);
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
      assert.equal(backend(subprocess).takeReport(subprocessPrepared.id)?.status, "completed");
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

function backend<T>(value: T): T {
  return value;
}

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

interface NormalizedPayload {
  system: string;
  orderedContents: string[];
  tools: string[];
}

function normalizePayload(payload: Record<string, unknown>): NormalizedPayload {
  const messages = payload.messages as {
    role: string;
    content: unknown;
  }[];
  const systemMessage = messages.find(
    (message) => message.role === "system" || message.role === "developer",
  );
  return {
    system: String(systemMessage?.content ?? ""),
    orderedContents: messages
      .filter((message) => message.role === "user" || message.role === "assistant")
      .map((message) =>
        typeof message.content === "string"
          ? message.content
          : JSON.stringify(message.content),
      )
      .map((content) =>
        content.includes("Prepared prior answer.")
          ? "Prepared prior answer."
          : content,
      ),
    tools: ((payload.tools as { function?: { name?: string } }[]) ?? []).map(
      (tool) => String(tool.function?.name),
    ),
  };
}

async function startMockProvider(
  payloads: Record<string, unknown>[],
): Promise<Server> {
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      payloads.push(JSON.parse(body));
      const usage = { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 };
      const chunk = (delta: Record<string, unknown>, finish: string | null) =>
        `data: ${JSON.stringify({
          id: "chatcmpl-e2e",
          object: "chat.completion.chunk",
          created: 1,
          model: MODEL_ID,
          choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(chunk({ role: "assistant", content: "E2E complete." }, null));
      response.write(
        `data: ${JSON.stringify({
          id: "chatcmpl-e2e",
          object: "chat.completion.chunk",
          created: 1,
          model: MODEL_ID,
          choices: [],
          usage,
        })}\n\n`,
      );
      response.write(chunk({}, "stop"));
      response.write("data: [DONE]\n\n");
      response.end();
    });
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  return server;
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
    api: "pi-runtime-e2e-api",
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
        name: "Fixture E2E model",
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

function resolvePiCli(): string | undefined {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    const candidate = join(directory, "pi");
    try {
      const resolved = realpathSync(candidate);
      if (existsSync(resolved)) {
        const probe = spawnSync(
          resolved.endsWith(".js") ? process.execPath : resolved,
          resolved.endsWith(".js") ? [resolved, "--version"] : ["--version"],
          { timeout: 10_000, stdio: "pipe" },
        );
        if (probe.status === 0) return resolved;
      }
    } catch {
      // Keep looking.
    }
  }
  return undefined;
}
