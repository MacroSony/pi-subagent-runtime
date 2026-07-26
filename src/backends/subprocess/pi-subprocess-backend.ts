import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  clampThinkingLevel,
  type Model,
  type ThinkingLevel,
} from "@earendil-works/pi-ai";
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
  canonicalJson,
  promptRuntimeFingerprint,
  type AccessCapabilities,
  type BackendDescriptor,
  type BackendPreflightResult,
  type BackendTool,
  type Diagnostic,
  type EnforcementReceipt,
  type Fingerprint,
  type ModelReference,
  type PreparedConversation,
  type PreparedMessage,
  type PromptRuntime,
  type RunUsage,
  type SealedPlanSnapshot,
} from "../../core/index.ts";
import type {
  AcceptedPreparationInput,
  BackendExecution,
  BackendExecutionContext,
  BackendPreparation,
  BackendPreparationContext,
  BackendPreflightInput,
  BackendResult,
  BoundExecutionInput,
  ExecutionBackend,
} from "../../runtime/index.ts";
import { modelRuntimeFromRegistry } from "./pi-model-runtime.ts";
import {
  SUBPROCESS_REPORT_FD_ENV,
  sanitizeSubprocessReportValue,
} from "./subprocess-report.ts";
import { SUBPROCESS_BRIDGE_INPUT_ENV } from "./subprocess-bridge.ts";

export const PI_SUBPROCESS_READONLY_BACKEND_ID = "pi-subprocess-readonly";

const MAX_STDOUT_BYTES = 8 * 1024 * 1024;
const MAX_REPORT_STREAM_BYTES = 8 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
export const MAX_RETAINED_SUBPROCESS_REPORT_BYTES = 512 * 1024;

const TERMINATE_GRACE_MS = 5_000;

/**
 * Fixed trigger text for the dry preparation session. The compiled
 * conversation replaces the session context before any provider request,
 * so this text is never model-visible beyond the lifecycle trigger.
 */
const PREPARATION_TRIGGER_PROMPT =
  "Prepare the subagent prompt runtime without contacting the provider.";

const VALID_THINKING_LEVELS = new Set([
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

const ACCESS_CAPABILITIES: AccessCapabilities = {
  readOnlyMountIsolation: false,
  readWriteMountIsolation: false,
  symlinkSafeContainment: false,
  processIsolation: false,
  agentNetworkIsolation: false,
};

const READ_ONLY_TOOL_CATALOG: readonly BackendTool[] = [
  {
    id: "pi.read",
    name: "read",
    description: "Read a file.",
    effects: ["filesystem-read"],
    adapterMapping: "pi:read",
  },
  {
    id: "pi.grep",
    name: "grep",
    description: "Search file contents.",
    effects: ["filesystem-read"],
    adapterMapping: "pi:grep",
  },
  {
    id: "pi.find",
    name: "find",
    description: "Find files by pattern.",
    effects: ["filesystem-read"],
    adapterMapping: "pi:find",
  },
  {
    id: "pi.ls",
    name: "ls",
    description: "List directory contents.",
    effects: ["filesystem-read"],
    adapterMapping: "pi:ls",
  },
];

export const PI_SUBPROCESS_READONLY_BACKEND_DESCRIPTOR: BackendDescriptor = {
  id: PI_SUBPROCESS_READONLY_BACKEND_ID,
  version: "0.1.0",
  capabilities: {
    access: { ...ACCESS_CAPABILITIES },
    executionBoundaries: ["shared-user"],
    limits: {
      timeoutMs: ["host-abort"],
      maxTurns: ["unsupported"],
      tokenBudget: ["unsupported"],
      maxOutputBytes: ["unsupported"],
    },
    cancellation: true,
    mediaMimeTypes: [],
    remoteTransport: true,
    promptRuntimeFidelity: "backend-assisted",
  },
};

export interface PiSubprocessUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: number;
  turns: number;
}

export interface PiSubprocessRunReport {
  preparedRunId: string;
  executionFingerprint: Fingerprint;
  status: "running" | "completed" | "failed" | "cancelled";
  startedAt: string;
  finishedAt?: string;
  exitCode?: number;
  signal?: NodeJS.Signals;
  model: ModelReference;
  thinkingLevel?: string;
  effectiveToolNames: string[];
  executionBoundary: "shared-user";
  workingDirectory: string;
  messages: unknown[];
  retention: {
    maxBytes: number;
    retainedBytes: number;
    truncated: boolean;
    omittedMessages: number;
  };
  stderr: string;
  usage: PiSubprocessUsage;
  stopReason?: string;
  errorMessage?: string;
}

interface PrimedSubprocessRun {
  preflightId: string;
  runtime: PromptRuntime;
  conversation: PreparedConversation;
  session: AgentSession;
  tempDir: string;
  providerGate: Deferred<void>;
  execution: Promise<void>;
  disposed: boolean;
}

interface PiInvocation {
  command: string;
  args: string[];
}

interface ActiveSubprocessRun {
  child: ChildProcess;
  termination?: Promise<void>;
  terminationReason?: string;
}

export interface PiSubprocessBackendOptions {
  modelRegistry: ModelRegistry;
  modelRuntime?: ModelRuntime;
  cwd: string;
  now?: () => Date;
  idFactory?: () => string;
  invocationFactory?: (piArgs: string[]) => PiInvocation;
  bridgePath?: string;
}

/**
 * Hybrid backend: an in-process Pi SDK AgentSession performs exact
 * backend-assisted preparation behind a provider gate, then a fresh Pi
 * child process executes the sealed conversation through the trusted
 * bridge. Enforcement is a model-visible tool allowlist only; receipts
 * honestly report a shared-user boundary.
 */
export class PiSubprocessBackend implements ExecutionBackend {
  readonly descriptor: BackendDescriptor = structuredClone(
    PI_SUBPROCESS_READONLY_BACKEND_DESCRIPTOR,
  );
  readonly #modelRegistry: ModelRegistry;
  readonly #modelRuntime: ModelRuntime;
  readonly #cwd: string;
  readonly #now: () => Date;
  readonly #idFactory: () => string;
  readonly #invocationFactory: (piArgs: string[]) => PiInvocation;
  readonly #bridgePath: string;
  readonly #primed = new Map<string, PrimedSubprocessRun>();
  readonly #active = new Map<string, ActiveSubprocessRun>();
  readonly #reports = new Map<string, PiSubprocessRunReport>();

  constructor(options: PiSubprocessBackendOptions) {
    this.#modelRegistry = options.modelRegistry;
    this.#modelRuntime =
      options.modelRuntime ?? modelRuntimeFromRegistry(options.modelRegistry);
    this.#cwd = options.cwd;
    this.#now = options.now ?? (() => new Date());
    this.#idFactory =
      options.idFactory ?? (() => `pi-subprocess-preflight:${randomUUID()}`);
    this.#invocationFactory = options.invocationFactory ?? defaultPiInvocation;
    this.#bridgePath = options.bridgePath ?? defaultBridgePath();
  }

  preflight(input: BackendPreflightInput): BackendPreflightResult {
    const diagnostics: Diagnostic[] = [];
    const { intent } = input;
    const access = intent.access;
    if (
      access.level !== "read-only" ||
      access.workspaces.length !== 1 ||
      access.workspaces[0]?.mode !== "read-only"
    ) {
      diagnostics.push(
        errorDiagnostic(
          "pi-subprocess.access",
          "The subprocess backend requires one read-only workspace.",
          "access",
        ),
      );
    }
    if (
      access.workingDirectory?.workspaceHandle !==
        access.workspaces[0]?.handle ||
      access.workingDirectory?.path !== "."
    ) {
      diagnostics.push(
        errorDiagnostic(
          "pi-subprocess.cwd",
          "The subprocess backend requires the requested workspace root as its working directory.",
          "access.workingDirectory",
        ),
      );
    }
    if (access.executionBoundary !== "shared-user") {
      diagnostics.push(
        errorDiagnostic(
          "pi-subprocess.boundary",
          "The subprocess backend cannot enforce an isolated execution boundary.",
          "access.executionBoundary",
        ),
      );
    }
    if (access.network !== "allow") {
      diagnostics.push(
        errorDiagnostic(
          "pi-subprocess.network",
          "A shared-user subprocess cannot honestly enforce network deny.",
          "access.network",
        ),
      );
    }
    if (access.allowProcess === true) {
      diagnostics.push(
        errorDiagnostic(
          "pi-subprocess.process",
          "The read-only subprocess does not expose process tools.",
          "access.allowProcess",
        ),
      );
    }
    if ((intent.media?.length ?? 0) > 0) {
      diagnostics.push(
        errorDiagnostic(
          "pi-subprocess.media",
          "The first subprocess backend supports text tasks only.",
          "media",
        ),
      );
    }
    for (const name of ["maxTurns", "tokenBudget", "maxOutputBytes"] as const) {
      const requirement = intent.limits[name];
      if (requirement?.enforcement === "required") {
        diagnostics.push(
          errorDiagnostic(
            "pi-subprocess.limit",
            `${name} cannot be enforced by the subprocess backend.`,
            `limits.${name}`,
          ),
        );
      } else if (requirement) {
        diagnostics.push(
          warningDiagnostic(
            "pi-subprocess.limit-ignored",
            `${name} is unsupported and will not be accepted.`,
            `limits.${name}`,
          ),
        );
      }
    }
    if (intent.limits.timeoutMs?.enforcement === "required") {
      diagnostics.push(
        errorDiagnostic(
          "pi-subprocess.limit",
          "The subprocess backend enforces timeouts only as host-abort, not backend-hard.",
          "limits.timeoutMs",
        ),
      );
    }

    if (intent.thinkingLevel === undefined) {
      diagnostics.push(
        errorDiagnostic(
          "pi-subprocess.thinking",
          "The subprocess backend requires an explicit thinking level.",
          "thinkingLevel",
        ),
      );
    } else if (!VALID_THINKING_LEVELS.has(intent.thinkingLevel)) {
      diagnostics.push(
        errorDiagnostic(
          "pi-subprocess.thinking",
          `Unsupported thinking level: ${intent.thinkingLevel}.`,
          "thinkingLevel",
        ),
      );
    }

    const catalogNames = new Set(
      READ_ONLY_TOOL_CATALOG.map((tool) => tool.name),
    );
    for (const [index, requested] of intent.requestedTools.entries()) {
      if (!catalogNames.has(requested)) {
        diagnostics.push(
          errorDiagnostic(
            "pi-subprocess.tool",
            `Requested tool is unavailable in the read-only subprocess: ${requested}.`,
            `requestedTools[${index}]`,
          ),
        );
      }
    }

    const model = this.#modelRegistry.find(
      intent.model.provider,
      intent.model.id,
    );
    if (!model) {
      diagnostics.push(
        errorDiagnostic(
          "pi-subprocess.model",
          `Unknown model: ${intent.model.provider}/${intent.model.id}`,
          "model",
        ),
      );
    } else {
      if (!this.#modelRegistry.hasConfiguredAuth(model)) {
        diagnostics.push(
          errorDiagnostic(
            "pi-subprocess.auth",
            `Model ${model.provider}/${model.id} has no configured authentication.`,
            "model",
          ),
        );
      }
      if (
        intent.thinkingLevel !== undefined &&
        VALID_THINKING_LEVELS.has(intent.thinkingLevel)
      ) {
        const effectiveThinking = clampThinkingLevel(
          model,
          intent.thinkingLevel as ThinkingLevel,
        );
        if (effectiveThinking !== intent.thinkingLevel) {
          diagnostics.push(
            errorDiagnostic(
              "pi-subprocess.thinking",
              `Model ${model.provider}/${model.id} would clamp thinking level ${intent.thinkingLevel} to ${effectiveThinking}.`,
              "thinkingLevel",
            ),
          );
        }
      }
    }

    const preflightId = this.#idFactory();
    if (
      diagnostics.some((diagnostic) => diagnostic.level === "error") ||
      !model
    ) {
      return {
        status: "rejected",
        preflightId,
        backend: structuredClone(this.descriptor),
        diagnostics,
      };
    }
    const workspace = access.workspaces[0]!;
    const acceptedLimits: {
      timeoutMs?: { value: number; enforcement: "host-abort" };
    } = {};
    if (intent.limits.timeoutMs) {
      acceptedLimits.timeoutMs = {
        value: intent.limits.timeoutMs.value,
        enforcement: "host-abort",
      };
    }
    diagnostics.push(
      warningDiagnostic(
        "pi-subprocess.shared-user",
        "Read-only is enforced by the model-visible tool allowlist, not by OS isolation; the subprocess retains the invoking user's permissions.",
        "access",
      ),
    );
    return {
      status: "accepted",
      preflightId,
      backend: structuredClone(this.descriptor),
      model: { provider: model.provider, id: model.id },
      ...(intent.thinkingLevel === undefined
        ? {}
        : { thinkingLevel: intent.thinkingLevel }),
      toolCatalog: structuredClone(READ_ONLY_TOOL_CATALOG),
      access: {
        level: "read-only",
        mounts: [
          {
            workspaceHandle: workspace.handle,
            mountId: "host-workspace",
            mode: "read-only",
          },
        ],
        workingDirectory: { mountId: "host-workspace", path: "." },
        network: "allow",
        process: false,
        executionBoundary: "shared-user",
        enforcement: { ...ACCESS_CAPABILITIES },
      },
      limits: acceptedLimits,
      diagnostics,
    };
  }

  async prepare(
    input: AcceptedPreparationInput,
    context: BackendPreparationContext,
  ): Promise<BackendPreparation> {
    if (this.#primed.has(input.preflight.preflightId)) {
      throw new Error(
        `Pi subprocess preflight is already prepared: ${input.preflight.preflightId}`,
      );
    }
    const model = this.#requireModel(
      input.preflight.model.provider,
      input.preflight.model.id,
    );
    const effectiveToolNames = this.#toolNamesFor(input);
    const tempDir = mkdtempSync(join(tmpdir(), "pi-subagent-runtime-prepare-"));
    const providerGate = deferred<void>();
    const preparationReady = deferred<PreparedConversation>();
    let runtime: PromptRuntime | undefined;
    let conversation: PreparedConversation | undefined;
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
      const compiled = await abortable(
        preparationReady.promise,
        context.signal,
      );
      conversation = compiled;
      if (!runtime) {
        throw new Error(
          "Pi subprocess preparation completed without a prompt runtime.",
        );
      }
      const primed: PrimedSubprocessRun = {
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
        new Error("Subprocess dry preparation stopped before provider transport."),
      );
      if (session) {
        await session.abort().catch(() => undefined);
        session.dispose();
      }
      rmSync(tempDir, { recursive: true, force: true });
      throw error;
    }
  }

  async start(
    input: BoundExecutionInput,
    context: BackendExecutionContext,
  ): Promise<BackendExecution> {
    const { plan } = input;
    const primed = input.preparation.state as PrimedSubprocessRun | undefined;
    if (
      !primed ||
      this.#primed.get(plan.preflightId) !== primed ||
      primed.disposed
    ) {
      throw new Error(
        "Pi subprocess execution has no matching prepared plan.",
      );
    }
    if (
      canonicalJson(primed.runtime) !== canonicalJson(plan.promptRuntime) ||
      canonicalJson(primed.conversation) !== canonicalJson(plan.conversation)
    ) {
      await this.#stopPreparation(primed);
      throw new Error(
        "Pi subprocess execution plan does not match its prepared prompt.",
      );
    }
    await this.#stopPreparation(primed);
    const effectiveToolNames = toolNamesForPlan(plan);
    const report = createReport(
      plan,
      this.#cwd,
      effectiveToolNames,
      this.#now(),
    );
    this.#reports.set(plan.preparedRunId, report);
    context.emit({
      phase: "starting",
      message: `Starting subprocess run with ${effectiveToolNames.join(", ") || "no tools"}.`,
      details: reportSummary(report),
    });

    const runDir = mkdtempSync(join(tmpdir(), "pi-subagent-runtime-run-"));
    let child: ChildProcess;
    try {
      const inputPath = join(runDir, "bridge-input.json");
      const systemPromptPath = join(runDir, "system-prompt.md");
      const marker = `PI_SUBAGENT_RUNTIME_MARKER_${randomUUID()}`;
      writeFileSync(
        inputPath,
        JSON.stringify({
          marker,
          systemPrompt: plan.conversation.systemPrompt,
          messages: plan.conversation.messages,
          model: plan.preflight.model,
          effectiveToolNames,
        }),
        { encoding: "utf8", mode: 0o600 },
      );
      writeFileSync(systemPromptPath, plan.conversation.systemPrompt, {
        encoding: "utf8",
        mode: 0o600,
      });
      const piArgs = subprocessArguments(
        plan,
        effectiveToolNames,
        this.#bridgePath,
        systemPromptPath,
        marker,
      );
      const invocation = this.#invocationFactory(piArgs);
      child = spawn(invocation.command, invocation.args, {
        cwd: this.#cwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          [SUBPROCESS_BRIDGE_INPUT_ENV]: inputPath,
          [SUBPROCESS_REPORT_FD_ENV]: "3",
        },
      });
    } catch (error) {
      rmSync(runDir, { recursive: true, force: true });
      report.status = context.signal.aborted ? "cancelled" : "failed";
      report.finishedAt = this.#now().toISOString();
      if (!context.signal.aborted) {
        report.errorMessage =
          error instanceof Error ? error.message : String(error);
      }
      throw error;
    }

    const terminal = this.#watchChild(child, plan, report, context, runDir);
    return {
      result: terminal,
      cancel: async (reason) => {
        await this.#terminateRun(plan.preparedRunId, reason);
      },
      dispose: async () => {
        await this.#terminateRun(
          plan.preparedRunId,
          "Subprocess execution disposed.",
        );
        rmSync(runDir, { recursive: true, force: true });
      },
    };
  }

  async discard(preparation: BackendPreparation): Promise<void> {
    const primed = preparation.state as PrimedSubprocessRun | undefined;
    if (!primed || this.#primed.get(primed.preflightId) !== primed) return;
    await this.#stopPreparation(primed);
  }

  /**
   * Returns the sanitized retained report for a finished run and removes it
   * from the backend. Reports are keyed by preparedRunId because a prepared
   * handle executes at most once.
   */
  takeReport(preparedRunId: string): PiSubprocessRunReport | undefined {
    const report = this.#reports.get(preparedRunId);
    if (!report) return undefined;
    this.#reports.delete(preparedRunId);
    return sanitizePiSubprocessRunReport(report);
  }

  /** Backend-level cleanup: stops preparations and terminates active runs. */
  async dispose(): Promise<void> {
    for (const primed of [...this.#primed.values()]) {
      await this.#stopPreparation(primed);
    }
    await Promise.all(
      [...this.#active.keys()].map((preparedRunId) =>
        this.#terminateRun(preparedRunId, "Subprocess backend disposed."),
      ),
    );
    this.#primed.clear();
    this.#active.clear();
    this.#reports.clear();
  }

  async #terminateRun(
    preparedRunId: string,
    reason?: string,
  ): Promise<void> {
    const active = this.#active.get(preparedRunId);
    if (!active) return;
    if (active.terminationReason === undefined && reason !== undefined) {
      active.terminationReason = reason;
    }
    active.termination ??= terminateChild(active.child);
    await active.termination;
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
            "Pi subprocess context event arrived before host preparation.",
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

  async #stopPreparation(primed: PrimedSubprocessRun): Promise<void> {
    if (primed.disposed) return;
    primed.disposed = true;
    this.#primed.delete(primed.preflightId);
    void primed.session.abort();
    primed.providerGate.reject(
      new Error(
        "Subprocess dry preparation completed without provider transport.",
      ),
    );
    await primed.execution.catch(() => undefined);
    primed.session.dispose();
    rmSync(primed.tempDir, { recursive: true, force: true });
  }

  #watchChild(
    child: ChildProcess,
    plan: SealedPlanSnapshot,
    report: PiSubprocessRunReport,
    context: BackendExecutionContext,
    runDir: string,
  ): Promise<BackendResult> {
    let stdoutBytes = 0;
    let reportBytes = 0;
    const active: ActiveSubprocessRun = { child };
    this.#active.set(plan.preparedRunId, active);
    const abort = () => {
      void this.#terminateRun(plan.preparedRunId, abortReason(context.signal));
    };
    if (context.signal.aborted) abort();
    else context.signal.addEventListener("abort", abort, { once: true });

    const failStream = (message: string): void => {
      if (!report.errorMessage) report.errorMessage = message;
      void this.#terminateRun(plan.preparedRunId);
    };
    const processLine = (line: string): void => {
      if (!line.trim()) return;
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line) as Record<string, unknown>;
      } catch {
        failStream("Subprocess bridge emitted malformed report JSON.");
        return;
      }
      if (event.type === "message_end" && event.message) {
        const message = sanitizePiSubprocessMessage(event.message);
        captureAssistantReceipt(report, message);
        appendReportMessage(report, message);
        if (isRecord(message) && message.role === "toolResult") {
          context.emit({
            phase: "tool-result",
            message: toolResultSummary(message),
            details: reportSummary(report),
          });
        } else {
          context.emit({
            phase: "message",
            message:
              latestAssistantText(report.messages) ||
              "Subagent completed a model turn.",
            details: reportSummary(report),
          });
        }
      }
    };

    if (!child.stdout) {
      failStream("Subprocess text output channel was unavailable.");
    } else {
      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > MAX_STDOUT_BYTES) {
          failStream(
            `Subprocess text output exceeded ${MAX_STDOUT_BYTES} bytes.`,
          );
        }
      });
    }
    const reportStream = child.stdio[3] as Readable | null;
    if (!reportStream) {
      failStream("Subprocess bridge report channel was unavailable.");
    } else {
      reportStream.on("data", (chunk: Buffer) => {
        reportBytes += chunk.length;
        if (reportBytes > MAX_REPORT_STREAM_BYTES) {
          failStream(
            `Sanitized subprocess report stream exceeded ${MAX_REPORT_STREAM_BYTES} bytes.`,
          );
        }
      });
      createInterface({ input: reportStream, crlfDelay: Infinity }).on(
        "line",
        processLine,
      );
    }
    if (!child.stderr) {
      failStream("Subprocess error output channel was unavailable.");
    } else {
      child.stderr.on("data", (chunk: Buffer) => {
        if (Buffer.byteLength(report.stderr, "utf8") >= MAX_STDERR_BYTES) {
          return;
        }
        report.stderr = appendBounded(
          report.stderr,
          chunk.toString("utf8"),
          MAX_STDERR_BYTES,
        );
      });
    }

    return new Promise<BackendResult>((resolve) => {
      let settled = false;
      const settle = (outcome: {
        code: number | null;
        signal: NodeJS.Signals | null;
        spawnError?: Error;
      }): void => {
        if (settled) return;
        settled = true;
        context.signal.removeEventListener("abort", abort);
        this.#active.delete(plan.preparedRunId);
        rmSync(runDir, { recursive: true, force: true });
        if (outcome.code !== null) report.exitCode = outcome.code;
        if (outcome.signal !== null) report.signal = outcome.signal;
        report.finishedAt = this.#now().toISOString();
        if (outcome.spawnError) report.errorMessage = outcome.spawnError.message;
        resolve(terminalResult(plan, report, active, context, outcome));
      };
      child.once("error", (error) =>
        settle({ code: null, signal: null, spawnError: error }),
      );
      child.once("close", (code, signal) => settle({ code, signal }));
    });
  }

  #requireModel(provider: string, id: string): Model<any> {
    const model = this.#modelRegistry.find(provider, id);
    if (!model) {
      throw new Error(
        `Pi subprocess model disappeared after preflight: ${provider}/${id}`,
      );
    }
    return model;
  }

  #toolNamesFor(input: AcceptedPreparationInput): string[] {
    const catalogNames = new Set(
      input.preflight.toolCatalog.map((tool) => tool.name),
    );
    return input.intent.requestedTools.map((requested) => {
      if (!catalogNames.has(requested)) {
        throw new Error(
          `Prepared subprocess tool disappeared from its catalog: ${requested}`,
        );
      }
      return requested;
    });
  }
}

function terminalResult(
  plan: SealedPlanSnapshot,
  report: PiSubprocessRunReport,
  active: ActiveSubprocessRun,
  context: BackendExecutionContext,
  outcome: { code: number | null; spawnError?: Error },
): BackendResult {
  const output = latestAssistantText(report.messages);
  const enforcement: EnforcementReceipt = {
    access: structuredClone(plan.preflight.access),
    limits: structuredClone(plan.preflight.limits),
  };
  const usage = runUsage(report.usage);

  if (context.signal.aborted || active.terminationReason) {
    report.status = "cancelled";
    context.emit({
      phase: "finishing",
      message: "Subagent cancelled.",
      details: reportSummary(report),
    });
    return {
      status: "cancelled",
      reason:
        active.terminationReason ?? abortReason(context.signal),
      enforcement,
      ...(usage ? { usage } : {}),
    };
  }
  if (
    outcome.spawnError ||
    outcome.code !== 0 ||
    report.stopReason === "error" ||
    report.stopReason === "aborted" ||
    report.errorMessage
  ) {
    report.status = "failed";
    const message =
      report.errorMessage ||
      report.stderr.trim() ||
      `Pi subprocess exited with code ${outcome.code ?? "unknown"}.`;
    context.emit({
      phase: "finishing",
      message: `Subagent failed: ${message}`,
      details: reportSummary(report),
    });
    return {
      status: "failed",
      error: { code: "subprocess", message, retryable: false },
      enforcement,
      ...(usage ? { usage } : {}),
      ...(output ? { output: { text: output, partial: true } } : {}),
    };
  }
  if (!output) {
    report.status = "failed";
    report.errorMessage = "Pi subprocess produced no assistant report.";
    context.emit({
      phase: "finishing",
      message: "Subagent failed: no assistant report.",
      details: reportSummary(report),
    });
    return {
      status: "failed",
      error: {
        code: "subprocess-empty",
        message: report.errorMessage,
        retryable: false,
      },
      enforcement,
      ...(usage ? { usage } : {}),
    };
  }
  report.status = "completed";
  context.emit({
    phase: "finishing",
    message: "Subagent report ready.",
    details: reportSummary(report),
  });
  return {
    status: "completed",
    output: { text: output, partial: false },
    enforcement,
    ...(usage ? { usage } : {}),
  };
}

export function sanitizePiSubprocessRunReport(
  report: PiSubprocessRunReport,
): PiSubprocessRunReport {
  const sanitized: PiSubprocessRunReport = {
    ...report,
    model: { ...report.model },
    effectiveToolNames: [...report.effectiveToolNames],
    messages: [],
    retention: createRetention(report.retention?.omittedMessages ?? 0),
    stderr: appendBounded(
      "",
      String(sanitizeSubprocessReportValue(report.stderr)),
      MAX_STDERR_BYTES,
    ),
    usage: { ...report.usage },
  };
  for (const message of report.messages) appendReportMessage(sanitized, message);
  return sanitized;
}

function sanitizePiSubprocessMessage(value: unknown): unknown {
  return sanitizeSubprocessReportValue(value);
}

function defaultPiInvocation(piArgs: string[]): PiInvocation {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtualScript && existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...piArgs] };
  }
  const execName = basename(process.execPath).toLowerCase();
  if (!/^(node|bun)(\.exe)?$/.test(execName)) {
    return { command: process.execPath, args: piArgs };
  }
  return { command: "pi", args: piArgs };
}

function defaultBridgePath(): string {
  const extension = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
  return join(
    dirname(fileURLToPath(import.meta.url)),
    `subprocess-bridge${extension}`,
  );
}

function subprocessArguments(
  plan: SealedPlanSnapshot,
  toolNames: string[],
  bridgePath: string,
  systemPromptPath: string,
  marker: string,
): string[] {
  const args = [
    "--mode",
    "text",
    "--print",
    "--no-session",
    "--model",
    `${plan.preflight.model.provider}/${plan.preflight.model.id}`,
    "--thinking",
    plan.preflight.thinkingLevel ?? "medium",
    "--system-prompt",
    systemPromptPath,
    "--extension",
    bridgePath,
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--approve",
  ];
  if (toolNames.length > 0) args.push("--tools", toolNames.join(","));
  else args.push("--no-tools");
  args.push(marker);
  return args;
}

function toolNamesForPlan(plan: SealedPlanSnapshot): string[] {
  return plan.effectiveTools.map((tool) => tool.backendToolName);
}

function createReport(
  plan: SealedPlanSnapshot,
  cwd: string,
  toolNames: string[],
  now: Date,
): PiSubprocessRunReport {
  return {
    preparedRunId: plan.preparedRunId,
    executionFingerprint: plan.executionFingerprint,
    status: "running",
    startedAt: now.toISOString(),
    model: structuredClone(plan.preflight.model),
    ...(plan.preflight.thinkingLevel === undefined
      ? {}
      : { thinkingLevel: plan.preflight.thinkingLevel }),
    effectiveToolNames: [...toolNames],
    executionBoundary: "shared-user",
    workingDirectory: cwd,
    messages: [],
    retention: createRetention(),
    stderr: "",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: 0,
      turns: 0,
    },
  };
}

function reportSummary(report: PiSubprocessRunReport): Omit<
  PiSubprocessRunReport,
  "messages" | "stderr"
> & { messageCount: number; stderrBytes: number } {
  const { messages, stderr, ...rest } = report;
  return {
    ...rest,
    usage: { ...report.usage },
    effectiveToolNames: [...report.effectiveToolNames],
    messageCount: messages.length,
    stderrBytes: Buffer.byteLength(stderr, "utf8"),
  };
}

function createRetention(
  omittedMessages = 0,
): PiSubprocessRunReport["retention"] {
  return {
    maxBytes: MAX_RETAINED_SUBPROCESS_REPORT_BYTES,
    retainedBytes: 0,
    truncated: omittedMessages > 0,
    omittedMessages,
  };
}

function appendReportMessage(
  report: PiSubprocessRunReport,
  value: unknown,
): void {
  let message = sanitizeSubprocessReportValue(value);
  let messageBytes = serializedBytes(message);
  if (messageBytes > report.retention.maxBytes) {
    message = summarizeOversizedMessage(message, messageBytes);
    messageBytes = serializedBytes(message);
    report.retention.truncated = true;
    report.retention.omittedMessages += 1;
  }
  report.messages.push(message);
  report.retention.retainedBytes += messageBytes;
  while (
    report.retention.retainedBytes > report.retention.maxBytes &&
    report.messages.length > 1
  ) {
    const removed = report.messages.shift();
    report.retention.retainedBytes -= serializedBytes(removed);
    report.retention.truncated = true;
    report.retention.omittedMessages += 1;
  }
}

function summarizeOversizedMessage(
  value: unknown,
  originalBytes: number,
): unknown {
  if (!isRecord(value)) {
    return `[Oversized subagent report message omitted: ${originalBytes} bytes]`;
  }
  const role = typeof value.role === "string" ? value.role : "custom";
  const summary: Record<string, unknown> = {
    role,
    content: [
      {
        type: "text",
        text: `[Oversized subagent report message compacted: ${originalBytes} bytes]`,
      },
    ],
    reportDataOmitted: true,
    originalBytes,
  };
  if (typeof value.toolName === "string") summary.toolName = value.toolName;
  if (typeof value.toolCallId === "string") summary.toolCallId = value.toolCallId;
  if (value.isError === true) summary.isError = true;
  if (role === "assistant") {
    const text = assistantText(value);
    if (text) summary.content = [{ type: "text", text }];
  }
  return summary;
}

function assistantText(value: Record<string, unknown>): string {
  if (!Array.isArray(value.content)) return "";
  return value.content
    .filter(isRecord)
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => String(part.text))
    .join("");
}

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? "null", "utf8");
}

function captureAssistantReceipt(
  report: PiSubprocessRunReport,
  value: unknown,
): void {
  if (!isRecord(value) || value.role !== "assistant") return;
  report.usage.turns += 1;
  if (isRecord(value.usage)) {
    report.usage.input += numberOrZero(value.usage.input);
    report.usage.output += numberOrZero(value.usage.output);
    report.usage.cacheRead += numberOrZero(value.usage.cacheRead);
    report.usage.cacheWrite += numberOrZero(value.usage.cacheWrite);
    report.usage.totalTokens += numberOrZero(value.usage.totalTokens);
    if (isRecord(value.usage.cost)) {
      report.usage.cost += numberOrZero(value.usage.cost.total);
    }
  }
  if (typeof value.stopReason === "string") {
    report.stopReason = value.stopReason;
  }
  if (typeof value.errorMessage === "string") {
    report.errorMessage = value.errorMessage;
  }
}

function runUsage(usage: PiSubprocessUsage): RunUsage | undefined {
  if (usage.turns === 0) return undefined;
  const integer = (value: number): number =>
    Math.max(0, Math.round(Number.isFinite(value) ? value : 0));
  const input = integer(usage.input);
  const output = integer(usage.output);
  return {
    tokens: {
      input,
      output,
      total: Math.max(integer(usage.totalTokens), input + output),
    },
    cost: { amount: Math.max(0, usage.cost), currency: "USD" },
  };
}

function latestAssistantText(messages: unknown[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (
      !isRecord(message) ||
      message.role !== "assistant" ||
      !Array.isArray(message.content)
    ) {
      continue;
    }
    const text = message.content
      .filter(isRecord)
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => String(part.text))
      .join("");
    if (text.trim()) return text.trim();
  }
  return "";
}

function toolResultSummary(value: unknown): string {
  if (!isRecord(value)) return "Subagent tool result received.";
  const name = typeof value.toolName === "string" ? value.toolName : "tool";
  const error = value.isError === true ? " failed" : " completed";
  return `${name}${error}.`;
}

function appendBounded(
  current: string,
  addition: string,
  maxBytes: number,
): string {
  const remaining = maxBytes - Buffer.byteLength(current, "utf8");
  if (remaining <= 0) return current;
  const bytes = Buffer.from(addition, "utf8");
  return current + bytes.subarray(0, remaining).toString("utf8");
}

async function terminateChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise<void>((resolve) =>
    child.once("close", () => resolve()),
  );
  child.kill("SIGTERM");
  const force = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }, TERMINATE_GRACE_MS);
  try {
    await closed;
  } finally {
    clearTimeout(force);
  }
}

function preparedMessageToAgentMessage(
  message: PreparedMessage,
  model: ModelReference,
  index: number,
): AgentMessage {
  if (message.content.some((part) => part.type === "media")) {
    throw new Error("Subprocess media preparation is not implemented.");
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

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
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

async function abortable<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    throw new Error("Pi subprocess preparation was cancelled.");
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () =>
      reject(new Error("Pi subprocess preparation was cancelled."));
    signal.addEventListener("abort", abort, { once: true });
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}

function abortReason(signal: AbortSignal): string {
  return typeof signal.reason === "string" && signal.reason
    ? signal.reason
    : "Subprocess execution cancelled.";
}

function errorDiagnostic(
  code: string,
  message: string,
  path?: string,
): Diagnostic {
  return { level: "error", code, message, ...(path ? { path } : {}) };
}

function warningDiagnostic(
  code: string,
  message: string,
  path?: string,
): Diagnostic {
  return { level: "warning", code, message, ...(path ? { path } : {}) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
