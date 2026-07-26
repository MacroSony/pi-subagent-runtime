import { spawnSync } from "node:child_process";
import { existsSync, realpathSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { delimiter, join } from "node:path";

/**
 * Shared machinery for end-to-end tests that drive a REAL pi CLI child
 * (text or RPC mode) against a local mock provider. Tests using these
 * helpers should skip when resolvePiCli() returns undefined.
 */

export function resolvePiCli(): string | undefined {
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

export function createPiInvocationFactory(
  piCli: string,
): (piArgs: string[]) => { command: string; args: string[] } {
  return (piArgs) =>
    piCli.endsWith(".js")
      ? { command: process.execPath, args: [piCli, ...piArgs] }
      : { command: piCli, args: piArgs };
}

/** Writes a hermetic models.json pointing a fixture provider at the mock server. */
export function writeFixtureModelsJson(
  agentDir: string,
  options: { provider: string; modelId: string; modelName?: string; port: number },
): void {
  writeFileSync(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        [options.provider]: {
          baseUrl: `http://127.0.0.1:${options.port}/v1`,
          api: "openai-completions",
          apiKey: "fixture",
          compat: {
            supportsDeveloperRole: false,
            supportsReasoningEffort: false,
          },
          models: [
            {
              id: options.modelId,
              name: options.modelName ?? "Fixture E2E model",
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
}

/** Local OpenAI-completions-shaped SSE mock; records every request payload. */
export async function startMockProvider(
  payloads: Record<string, unknown>[],
  options?: { responseText?: string; modelId?: string },
): Promise<Server> {
  const responseText = options?.responseText ?? "E2E complete.";
  const modelId = options?.modelId ?? "fixture-model";
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
          model: modelId,
          choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(chunk({ role: "assistant", content: responseText }, null));
      response.write(
        `data: ${JSON.stringify({
          id: "chatcmpl-e2e",
          object: "chat.completion.chunk",
          created: 1,
          model: modelId,
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

export interface NormalizedProviderPayload {
  system: string;
  orderedContents: string[];
  tools: string[];
}

/** Reduces a provider request to the sealed-conversation surface a host owns. */
export function normalizeProviderPayload(
  payload: Record<string, unknown>,
): NormalizedProviderPayload {
  const messages = payload.messages as {
    role: string;
    content: unknown;
  }[];
  const systemMessage = messages.find(
    (message) => message.role === "system" || message.role === "developer",
  );
  return {
    system: textOf(systemMessage?.content),
    orderedContents: messages
      .filter((message) => message.role === "user" || message.role === "assistant")
      .map((message) => textOf(message.content)),
    tools: ((payload.tools as { function?: { name?: string } }[]) ?? []).map(
      (tool) => String(tool.function?.name),
    ),
  };
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
          ? (part as { text: string }).text
          : "",
      )
      .join("");
  }
  return String(content ?? "");
}
