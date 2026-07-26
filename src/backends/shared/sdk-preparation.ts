import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-ai";
import {
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  createAgentSession,
  type AgentSession,
  type BuildSystemPromptOptions,
  type ExtensionAPI,
  type ExtensionFactory,
  type ModelRegistry,
  type ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import {
  promptRuntimeFingerprint,
  type ModelReference,
  type PreparedConversation,
  type PreparedMessage,
  type PromptRuntime,
} from "../../core/index.ts";
import type {
  AcceptedPreparationInput,
  BackendPreparation,
  BackendPreparationContext,
} from "../../runtime/index.ts";
import { modelRuntimeFromRegistry } from "./pi-model-runtime.ts";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

/**
 * Fixed trigger text for the dry preparation session. The compiled
 * conversation replaces the session context before any provider request,
 * so this text is never model-visible beyond the lifecycle trigger.
 */
const PREPARATION_TRIGGER_PROMPT =
  "Prepare the subagent prompt runtime without contacting the provider.";

export interface PrimedPreparation {
  preflightId: string;
  runtime: PromptRuntime;
  conversation: PreparedConversation;
  session: AgentSession;
  tempDir: string;
  providerGate: Deferred<void>;
  execution: Promise<void>;
  disposed: boolean;
}

export interface SdkPreparationGateOptions {
  modelRegistry: ModelRegistry;
  modelRuntime?: ModelRuntime;
  cwd: string;
  now?: () => Date;
  tempDirPrefix?: string;
}

/**
 * Adapter-private, Pi-SDK-backed preparation component shared by the
 * fresh-process backends. It owns the temporary AgentSession, the
 * before_agent_start provider gate, and the Pi runtime extraction needed
 * for exact host compilation. Pi version coupling stays confined to the
 * backend entry points that compose this component.
 */
export class SdkPreparationGate {
  readonly #modelRegistry: ModelRegistry;
  readonly #modelRuntime: ModelRuntime;
  readonly #cwd: string;
  readonly #now: () => Date;
  readonly #tempDirPrefix: string;
  readonly #primed = new Map<string, PrimedPreparation>();

  constructor(options: SdkPreparationGateOptions) {
    this.#modelRegistry = options.modelRegistry;
    this.#modelRuntime =
      options.modelRuntime ?? modelRuntimeFromRegistry(options.modelRegistry);
    this.#cwd = options.cwd;
    this.#now = options.now ?? (() => new Date());
    this.#tempDirPrefix = options.tempDirPrefix ?? "pi-subagent-runtime-prepare-";
  }

  get(model: PrimedPreparation["preflightId"]): PrimedPreparation | undefined {
    return this.#primed.get(model);
  }

  async prepare(
    input: AcceptedPreparationInput,
    context: BackendPreparationContext,
  ): Promise<BackendPreparation> {
    if (this.#primed.has(input.preflight.preflightId)) {
      throw new Error(
        `Pi preparation gate already holds preflight: ${input.preflight.preflightId}`,
      );
    }
    const model = this.#modelRegistry.find(
      input.preflight.model.provider,
      input.preflight.model.id,
    );
    if (!model) {
      throw new Error(
        `Pi model disappeared after preflight: ${input.preflight.model.provider}/${input.preflight.model.id}`,
      );
    }
    const effectiveToolNames = toolNamesFor(input);
    const tempDir = mkdtempSync(join(tmpdir(), this.#tempDirPrefix));
    const providerGate = deferred<void>();
    const preparationReady = deferred<PreparedConversation>();
    let runtime: PromptRuntime | undefined;
    let session: AgentSession | undefined;
    try {
      const settingsManager = SettingsManager.create(this.#cwd, tempDir, {
        projectTrusted: true,
      });
      const resourceLoader = new DefaultResourceLoader({
        cwd: this.#cwd,
        agentDir: tempDir,
        settingsManager,
        extensionFactories: [
          {
            name: "pi-subagent-runtime-preparation",
            factory: this.#compilerBridge(
              input,
              context,
              providerGate,
              preparationReady,
              (candidateRuntime) => {
                runtime = candidateRuntime;
              },
            ),
          },
        ],
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
      });
      await resourceLoader.reload();
      const created = await createAgentSession({
        cwd: this.#cwd,
        agentDir: tempDir,
        modelRuntime: this.#modelRuntime,
        model,
        thinkingLevel: input.preflight.thinkingLevel as ThinkingLevel,
        resourceLoader,
        settingsManager,
        sessionManager: SessionManager.inMemory(this.#cwd),
        noTools: "all",
        tools: effectiveToolNames,
      });
      session = created.session;
      session.setActiveToolsByName(effectiveToolNames);
      const execution = this.#startPreparation(session, preparationReady);
      const conversation = await abortable(
        preparationReady.promise,
        context.signal,
      );
      if (!runtime) {
        throw new Error(
          "Pi preparation completed without a prompt runtime.",
        );
      }
      const primed: PrimedPreparation = {
        preflightId: input.preflight.preflightId,
        runtime,
        conversation,
        session,
        tempDir,
        providerGate,
        execution,
        disposed: false,
      };
      this.#primed.set(input.preflight.preflightId, primed);
      return { runtime, conversation, state: primed };
    } catch (error) {
      providerGate.reject(
        new Error("Dry preparation stopped before provider transport."),
      );
      if (session) {
        await session.abort().catch(() => undefined);
        session.dispose();
      }
      rmSync(tempDir, { recursive: true, force: true });
      throw error;
    }
  }

  /** Releases a primed preparation exactly once. */
  async stop(primed: PrimedPreparation): Promise<void> {
    if (primed.disposed) return;
    primed.disposed = true;
    this.#primed.delete(primed.preflightId);
    void primed.session.abort();
    primed.providerGate.reject(
      new Error("Dry preparation completed without provider transport."),
    );
    await primed.execution.catch(() => undefined);
    primed.session.dispose();
    rmSync(primed.tempDir, { recursive: true, force: true });
  }

  async stopAll(): Promise<void> {
    for (const primed of [...this.#primed.values()]) await this.stop(primed);
  }

  #compilerBridge(
    input: AcceptedPreparationInput,
    context: BackendPreparationContext,
    providerGate: Deferred<void>,
    preparationReady: Deferred<PreparedConversation>,
    setRuntime: (runtime: PromptRuntime) => void,
  ): ExtensionFactory {
    return (pi: ExtensionAPI) => {
      let compiled: PreparedConversation | undefined;
      pi.on("before_agent_start", async (event) => {
        try {
          const runtime = this.#runtimeSnapshot(
            input.preflight.model,
            event.systemPrompt,
            event.systemPromptOptions,
          );
          setRuntime(runtime);
          compiled = await context.compile(runtime);
          preparationReady.resolve(compiled);
          return { systemPrompt: compiled.systemPrompt };
        } catch (error) {
          preparationReady.reject(error);
          providerGate.reject(error);
          throw error;
        }
      });
      pi.on("context", () => {
        if (!compiled) {
          throw new Error(
            "Pi context event arrived before host preparation.",
          );
        }
        return {
          messages: compiled.messages.map((message, index) =>
            preparedMessageToAgentMessage(
              message,
              input.preflight.model,
              index,
            ),
          ),
        };
      });
      pi.on("before_provider_request", async () => {
        await providerGate.promise;
      });
    };
  }

  #runtimeSnapshot(
    model: ModelReference,
    baseSystemPrompt: string,
    options: BuildSystemPromptOptions,
  ): PromptRuntime {
    const runtime: Omit<PromptRuntime, "promptRuntimeFingerprint"> = {
      baseSystemPrompt,
      options: {
        ...(options.customPrompt === undefined
          ? {}
          : { customPrompt: options.customPrompt }),
        selectedTools: [...(options.selectedTools ?? [])],
        toolSnippets: { ...(options.toolSnippets ?? {}) },
        promptGuidelines: [...(options.promptGuidelines ?? [])],
        ...(options.appendSystemPrompt === undefined
          ? {}
          : { appendSystemPrompt: options.appendSystemPrompt }),
        cwd: options.cwd,
        contextFiles: [],
        skills: [],
      },
      model: structuredClone(model),
      preparedAt: this.#now().toISOString(),
      fidelity: "backend-assisted",
    };
    return {
      ...runtime,
      promptRuntimeFingerprint: promptRuntimeFingerprint(runtime),
    };
  }

  async #startPreparation(
    session: AgentSession,
    preparationReady: Deferred<PreparedConversation>,
  ): Promise<void> {
    try {
      await session.prompt(PREPARATION_TRIGGER_PROMPT, {
        source: "extension",
      });
      await session.waitForIdle();
    } catch (error) {
      preparationReady.reject(error);
    }
  }
}

export interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

export function deferred<T>(): Deferred<T> {
  let settled = false;
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = (value) => {
      if (settled) return;
      settled = true;
      resolvePromise(value);
    };
    reject = (error) => {
      if (settled) return;
      settled = true;
      rejectPromise(error);
    };
  });
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}

export async function abortable<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    throw new Error("Pi preparation was cancelled.");
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new Error("Pi preparation was cancelled."));
    signal.addEventListener("abort", abort, { once: true });
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}

function toolNamesFor(input: AcceptedPreparationInput): string[] {
  const catalogNames = new Set(
    input.preflight.toolCatalog.map((tool) => tool.name),
  );
  return input.intent.requestedTools.map((requested) => {
    if (!catalogNames.has(requested)) {
      throw new Error(
        `Prepared process tool disappeared from its catalog: ${requested}`,
      );
    }
    return requested;
  });
}

function preparedMessageToAgentMessage(
  message: PreparedMessage,
  model: ModelReference,
  index: number,
): AgentMessage {
  if (message.content.some((part) => part.type === "media")) {
    throw new Error("Process media preparation is not implemented.");
  }
  const content = message.content.map((part) => ({
    type: "text" as const,
    text: part.type === "text" ? part.text : "",
  }));
  if (message.role === "user") {
    return {
      role: "user",
      content: content.length === 1 ? content[0]!.text : content,
      timestamp: index,
    } as AgentMessage;
  }
  if (message.role === "custom") {
    return {
      role: "custom",
      customType: "pi-subagent-runtime",
      content,
      display: false,
      details: {},
      timestamp: index,
    } as AgentMessage;
  }
  return {
    role: "assistant",
    content,
    api: "unknown",
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: index,
  } as AgentMessage;
}
