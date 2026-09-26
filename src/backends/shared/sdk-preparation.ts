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
import {
  modelRuntimeFromRegistry,
  type PiModelRegistry,
} from "./pi-model-runtime.ts";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

/**
 * Fixed trigger text for the dry preparation session. The compiled
 * conversation replaces the session context before any provider request,
 * so this text is never model-visible beyond the lifecycle trigger.
 */
const PREPARATION_TRIGGER_PROMPT =
  "Prepare the subagent prompt runtime without contacting the provider.";

/** Bounded wait for a stopped execution before cleanup proceeds anyway. */
const STOP_GRACE_MS = 3_000;

export interface PrimedPreparation {
  preflightId: string;
  runtime: PromptRuntime;
  conversation: PreparedConversation;
  session: AgentSession;
  tempDir: string;
  providerGate: Deferred<void>;
  execution: Promise<void>;
  /** Reset the provider gate before a retained session's next turn. */
  rearmProviderGate: () => Deferred<void>;
  /** Start a real user turn on this already-created AgentSession. */
  startTurn: (task: string) => Promise<void>;
  disposed: boolean;
  /** The in-flight stop attempt, shared by concurrent cleanup callers. */
  stopPromise: Promise<void> | undefined;
  /**
   * Permanently blocks provider transport for this preparation at the stream
   * level. Extension-hook errors are caught by the Pi event runner, so a
   * rejected providerGate alone cannot stop a provider call; this can.
   */
  stopTransport: () => void;
}

/** A preparation that has started but not yet primed; tracked so stopAll() cannot miss it. */
interface InFlightPreparation {
  tempDir: string;
  providerGate: Deferred<void>;
  stopTransport: () => void;
  session?: AgentSession;
  cancelled: boolean;
  done: Deferred<void>;
}

export interface SdkPreparationGateOptions {
  modelRegistry: PiModelRegistry;
  modelRuntime?: ModelRuntime;
  cwd: string;
  now?: () => Date;
  tempDirPrefix?: string;
  /**
   * When true, the compiled conversation replaces the preparation trigger on
   * every context event, so multi-turn runs keep the sealed conversation
   * alongside accumulated tool results. In-process backends need this to
   * resume the parked session as the real execution (multi-turn).
   * Fresh-process backends keep the default pinning behavior, which only
   * ever fires once before the provider gate.
   */
  executablePreparations?: boolean;
}

/**
 * Adapter-private, Pi-SDK-backed preparation component shared by the
 * fresh-process backends. It owns the temporary AgentSession, the
 * before_agent_start provider gate, and the Pi runtime extraction needed
 * for exact host compilation. Pi version coupling stays confined to the
 * backend entry points that compose this component.
 */
export class SdkPreparationGate {
  readonly #modelRegistry: PiModelRegistry;
  readonly #modelRuntime: ModelRuntime;
  readonly #cwd: string;
  readonly #now: () => Date;
  readonly #tempDirPrefix: string;
  readonly #executablePreparations: boolean;
  readonly #primed = new Map<string, PrimedPreparation>();
  readonly #inFlight = new Set<InFlightPreparation>();
  #closed = false;

  constructor(options: SdkPreparationGateOptions) {
    this.#modelRegistry = options.modelRegistry;
    this.#modelRuntime =
      options.modelRuntime ?? modelRuntimeFromRegistry(options.modelRegistry);
    this.#cwd = options.cwd;
    this.#now = options.now ?? (() => new Date());
    this.#tempDirPrefix = options.tempDirPrefix ?? "pi-subagent-runtime-prepare-";
    this.#executablePreparations = options.executablePreparations ?? false;
  }

  get(model: PrimedPreparation["preflightId"]): PrimedPreparation | undefined {
    const primed = this.#primed.get(model);
    return primed && !primed.stopPromise ? primed : undefined;
  }

  async prepare(
    input: AcceptedPreparationInput,
    context: BackendPreparationContext,
  ): Promise<BackendPreparation> {
    // After stopAll() no new preparation may begin; otherwise one could prime
    // after disposal has already iterated the in-flight set.
    if (this.#closed) {
      throw new Error("Pi preparation gate is closed to new preparations.");
    }
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
    let execution: Promise<void> | undefined;
    let currentProviderGate = providerGate;
    // Extension-hook errors are swallowed by the Pi event runner, so provider
    // transport is additionally blocked in the stream path itself.
    let transportStopped = false;
    const inFlight: InFlightPreparation = {
      tempDir,
      providerGate,
      stopTransport: () => {
        transportStopped = true;
      },
      cancelled: false,
      done: deferred<void>(),
    };
    this.#inFlight.add(inFlight);
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
              () => currentProviderGate,
              preparationReady,
              (candidateRuntime) => {
                runtime = candidateRuntime;
              },
              () => {
                transportStopped = true;
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
      // Simple continuation preserves the original full context: do not
      // silently summarize it or trigger a separate compaction model request.
      // This is an in-memory override, never a target/user settings write.
      if (input.intent.continuation?.retain) {
        settingsManager.applyOverrides({ compaction: { enabled: false } });
      }
      const created = await createAgentSession({
        cwd: this.#cwd,
        agentDir: tempDir,
        modelRuntime: transportGatedRuntime(this.#modelRuntime, () => transportStopped),
        model,
        thinkingLevel: input.preflight.thinkingLevel as ThinkingLevel,
        resourceLoader,
        settingsManager,
        sessionManager: SessionManager.inMemory(this.#cwd),
        noTools: "all",
        tools: effectiveToolNames,
      });
      session = created.session;
      inFlight.session = session;
      session.setActiveToolsByName(effectiveToolNames);
      execution = this.#startPreparation(session, preparationReady);
      const conversation = await abortable(
        preparationReady.promise,
        context.signal,
      );
      if (inFlight.cancelled) {
        throw new Error("Pi preparation was disposed before it completed.");
      }
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
        providerGate: currentProviderGate,
        execution,
        rearmProviderGate: () => {
          currentProviderGate = deferred<void>();
          primed.providerGate = currentProviderGate;
          return currentProviderGate;
        },
        startTurn: (task: string) => {
          const turn = this.#startTurn(session!, task);
          primed.execution = turn;
          return turn;
        },
        disposed: false,
        stopPromise: undefined,
        stopTransport: inFlight.stopTransport,
      };
      this.#primed.set(input.preflight.preflightId, primed);
      return { runtime, conversation, state: primed };
    } catch (error) {
      inFlight.stopTransport();
      providerGate.reject(
        new Error("Dry preparation stopped before provider transport."),
      );
      if (execution) void execution.catch(() => undefined);
      if (session) {
        await session.abort().catch(() => undefined);
        session.dispose();
      }
      rmSync(tempDir, { recursive: true, force: true });
      throw error;
    } finally {
      this.#inFlight.delete(inFlight);
      inFlight.done.resolve();
    }
  }

  /** Releases a primed preparation exactly once. */
  async stop(primed: PrimedPreparation): Promise<void> {
    if (primed.disposed) return;
    if (primed.stopPromise) return primed.stopPromise;

    let stopPromise!: Promise<void>;
    const attempt = (async () => {
      // Stop transport before waiting for or disposing anything. This is
      // intentionally repeated on retries: a failed cleanup must remain
      // fail-closed and must not be able to start another provider request.
      primed.stopTransport();
      void primed.session.abort().catch(() => undefined);
      primed.providerGate.reject(
        new Error("Dry preparation completed without provider transport."),
      );
      // A resumed (in-process) execution may be stuck on a non-cooperative
      // provider even after abort and transport-stop; never hang cleanup on it.
      await Promise.race([
        primed.execution.catch(() => undefined),
        new Promise<void>((resolve) => setTimeout(resolve, STOP_GRACE_MS)),
      ]);

      // Try both independent cleanup operations. If either fails, the
      // preparation remains owned and a later stop() can retry both safely.
      const failures: unknown[] = [];
      try {
        primed.session.dispose();
      } catch (error) {
        failures.push(error);
      }
      try {
        rmSync(primed.tempDir, { recursive: true, force: true });
      } catch (error) {
        failures.push(error);
      }
      if (failures.length > 0) {
        throw new AggregateError(failures, "Pi preparation cleanup failed.");
      }
    })();
    stopPromise = attempt.then(
      () => {
        primed.disposed = true;
        if (this.#primed.get(primed.preflightId) === primed) {
          this.#primed.delete(primed.preflightId);
        }
      },
      (error) => {
        // Do not mark disposed or remove the gate entry on failure. The owner
        // is deliberately retained for an explicit or backend-wide retry.
        throw error;
      },
    ).finally(() => {
      if (!primed.disposed && primed.stopPromise === stopPromise) {
        primed.stopPromise = undefined;
      }
    });
    primed.stopPromise = stopPromise;
    return stopPromise;
  }

  /**
   * Hands ownership of a primed preparation to the caller without disposing
   * anything. In-process backends use this to resume the parked session as the
   * actual execution instead of replaying the sealed conversation elsewhere.
   * After take(), the caller owns session disposal, the provider gate, the
   * execution promise, and tempDir cleanup.
   */
  take(preflightId: string): PrimedPreparation | undefined {
    if (this.#closed) return undefined;
    const primed = this.#primed.get(preflightId);
    if (!primed || primed.disposed || primed.stopPromise) return undefined;
    this.#primed.delete(preflightId);
    return primed;
  }

  async stopAll(): Promise<void> {
    // Close the gate first so no new preparation can begin racing disposal.
    this.#closed = true;
    // Cancel preparations that have not primed yet; they would otherwise
    // insert themselves into the primed map after stopAll() has iterated it.
    for (const record of [...this.#inFlight]) {
      record.cancelled = true;
      record.stopTransport();
      record.providerGate.reject(
        new Error("Pi preparation gate disposed during preparation."),
      );
      if (record.session) void record.session.abort();
    }
    await Promise.all(
      [...this.#inFlight].map((record) => record.done.promise),
    );
    const outcomes = await Promise.allSettled(
      [...this.#primed.values()].map((primed) => this.stop(primed)),
    );
    const failures = outcomes
      .filter(
        (outcome): outcome is PromiseRejectedResult =>
          outcome.status === "rejected",
      )
      .map(({ reason }) => reason);
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        "Pi preparation gate cleanup encountered failures.",
      );
    }
  }

  #compilerBridge(
    input: AcceptedPreparationInput,
    context: BackendPreparationContext,
    providerGate: () => Deferred<void>,
    preparationReady: Deferred<PreparedConversation>,
    setRuntime: (runtime: PromptRuntime) => void,
    failClosed: () => void,
  ): ExtensionFactory {
    return (pi: ExtensionAPI) => {
      let compiled: PreparedConversation | undefined;
      pi.on("before_agent_start", async (event) => {
        try {
          // The host compiler belongs to preparation, not to later turns.
          // Reusing the frozen result also preserves the original system
          // prompt/tools while the context bridge supplies accumulated history.
          if (compiled) return { systemPrompt: compiled.systemPrompt };
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
          providerGate().reject(error);
          failClosed();
          throw error;
        }
      });
      pi.on("context", (event) => {
        if (!compiled) {
          const error = new Error(
            "Pi context event arrived before host preparation.",
          );
          failClosed();
          providerGate().reject(error);
          throw error;
        }
        const compiledMessages = compiled.messages.map((message, index) =>
          preparedMessageToAgentMessage(message, input.preflight.model, index),
        );
        if (!this.#executablePreparations) {
          // Dry preparations park before the first provider request, so the
          // whole-list replacement below only ever fires once.
          return { messages: compiledMessages };
        }
        // Executable preparations: transformContext only rewrites the outgoing
        // request; the trigger stays in the agent transcript. Replace the
        // trigger with the compiled conversation on every provider request so
        // later turns keep their accumulated assistant/tool messages without
        // losing the sealed conversation or leaking the trigger.
        const triggerIndex = event.messages.findIndex((message) =>
          isTriggerMessage(message),
        );
        if (triggerIndex === -1) {
          // A missing trigger means Pi compacted/folded away the bridge's
          // anchor. Continuing with the native context would silently omit
          // the original compiled conversation, so fail closed instead.
          const error = new Error(
            "Pi retained context lost the preparation trigger; refusing provider transport.",
          );
          failClosed();
          providerGate().reject(error);
          throw error;
        }
        return {
          messages: [
            ...event.messages.slice(0, triggerIndex),
            ...compiledMessages,
            ...event.messages.slice(triggerIndex + 1),
          ],
        };
      });
      pi.on("before_provider_request", async () => {
        await providerGate().promise;
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
      // Once preparation has already resolved the rejection above is a no-op;
      // still propagate so in-process executions observe the real failure
      // instead of a generic "no assistant report".
      throw error;
    }
  }

  async #startTurn(session: AgentSession, task: string): Promise<void> {
    await session.prompt(task, { source: "extension" });
    await session.waitForIdle();
  }
}

function isTriggerMessage(message: AgentMessage): boolean {
  if (message.role !== "user") return false;
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content === PREPARATION_TRIGGER_PROMPT;
  if (Array.isArray(content)) {
    const first = content[0] as { type?: unknown; text?: unknown } | undefined;
    return (
      content.length === 1 &&
      first?.type === "text" &&
      first.text === PREPARATION_TRIGGER_PROMPT
    );
  }
  return false;
}

/**
 * Proxy around the host ModelRuntime that refuses provider transport once the
 * preparation has been stopped. The Pi event runner catches extension-hook
 * errors, so the before_provider_request gate alone cannot guarantee a stopped
 * preparation never reaches the provider.
 */
function transportGatedRuntime(
  modelRuntime: ModelRuntime,
  isStopped: () => boolean,
): ModelRuntime {
  return new Proxy(modelRuntime, {
    get(target, property) {
      if (property === "streamSimple") {
        return (...args: unknown[]) => {
          if (isStopped()) {
            throw new Error(
              "Pi preparation was stopped before provider transport.",
            );
          }
          const streamSimple = Reflect.get(target, property, target) as (
            ...streamArgs: unknown[]
          ) => unknown;
          return streamSimple.apply(target, args);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
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
