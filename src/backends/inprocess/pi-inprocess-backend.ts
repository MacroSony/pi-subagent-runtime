import { randomUUID } from "node:crypto";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  canonicalJson,
  fingerprint,
  type BackendDescriptor,
  type BackendPreflightResult,
  type EnforcementReceipt,
  type SealedPlanSnapshot,
  type PreparedConversation,
  type PreparedMessage,
  type PromptRuntime,
} from "../../core/index.ts";
import type {
  AcceptedPreparationInput,
  BackendExecution,
  BackendExecutionContext,
  BackendPreflightInput,
  BackendPreparation,
  BackendPreparationContext,
  BackendResult,
  BoundExecutionInput,
  ExecutionBackend,
} from "../../runtime/index.ts";
import {
  deferred,
  SdkPreparationGate,
  type Deferred,
  type PrimedPreparation,
} from "../shared/sdk-preparation.ts";
import type { PiModelRegistry } from "../shared/pi-model-runtime.ts";
import {
  appendProcessReportMessage,
  captureProcessAssistantReceipt,
  createProcessReport,
  latestProcessAssistantText,
  processReportSummary,
  processRunUsage,
  processToolResultSummary,
  sanitizeProcessRunReport,
  isRecord,
  type ProcessRunReport,
} from "../shared/process-report.ts";
import { sanitizeSubprocessReportValue } from "../shared/report-sanitize.ts";
import {
  acceptedInProcessPreflight,
  evaluateInProcessIntent,
  PI_INPROCESS_TOOL_CATALOG,
} from "./preflight-policy.ts";

export const PI_INPROCESS_BACKEND_ID = "pi-inprocess";
export const PI_INPROCESS_BACKEND_DESCRIPTOR: BackendDescriptor = {
  id: PI_INPROCESS_BACKEND_ID,
  version: "0.1.0",
  capabilities: {
    access: {
      readOnlyMountIsolation: false,
      readWriteMountIsolation: false,
      symlinkSafeContainment: false,
      processIsolation: false,
      agentNetworkIsolation: false,
    },
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
    continuation: true,
  },
};

export type PiInProcessRunReport = ProcessRunReport;

export interface PiInProcessBackendOptions {
  modelRegistry: PiModelRegistry;
  modelRuntime?: ModelRuntime;
  cwd: string;
  now?: () => Date;
  idFactory?: () => string;
  tempDirPrefix?: string;
  /** Maximum number of retained in-memory child sessions. */
  maxRetainedContinuations?: number;
}

const TERMINATE_GRACE_MS = 3_000;

interface RetainedContinuation {
  id: string;
  primed: PrimedPreparation;
  binding: string;
  runtime: PromptRuntime;
  conversation: PreparedConversation;
  reservedBy: string | undefined;
}

interface ContinuationPreparation {
  kind: "continuation";
  retained: RetainedContinuation;
  task: string;
}

interface ActiveInProcessRun {
  session: PrimedPreparation["session"];
  retained?: RetainedContinuation;
  /** Resolved when a bounded termination gives up waiting for the provider. */
  forceSettle: Deferred<void>;
  terminationReason?: string;
  termination?: Promise<void>;
}

/**
 * Shared-user in-process backend. Preparation primes a real AgentSession
 * against the host model runtime (so extension-registered providers work
 * unchanged); execution resumes that very session instead of replaying the
 * sealed conversation in a fresh process. The tool allowlist is a
 * same-process policy boundary — there is no OS isolation, and the access
 * receipt says so.
 */
export class PiInProcessBackend implements ExecutionBackend {
  readonly descriptor = structuredClone(PI_INPROCESS_BACKEND_DESCRIPTOR);
  #preparations: SdkPreparationGate;
  #modelRegistry: PiModelRegistry;
  #cwd: string;
  #now: () => Date;
  #idFactory: () => string;
  #active = new Map<string, ActiveInProcessRun>();
  #reports = new Map<string, ProcessRunReport>();
  #retained = new Map<string, RetainedContinuation>();
  /** Reservations made by accepted first-run retain intents. */
  #retentionReservations = new Set<string>();
  #maxRetained: number;

  constructor(options: PiInProcessBackendOptions) {
    this.#modelRegistry = options.modelRegistry;
    this.#preparations = new SdkPreparationGate({
      modelRegistry: options.modelRegistry,
      ...(options.modelRuntime ? { modelRuntime: options.modelRuntime } : {}),
      cwd: options.cwd,
      ...(options.now ? { now: options.now } : {}),
      tempDirPrefix:
        options.tempDirPrefix ?? "pi-subagent-runtime-inprocess-prepare-",
      executablePreparations: true,
    });
    this.#cwd = options.cwd;
    this.#now = options.now ?? (() => new Date());
    this.#idFactory =
      options.idFactory ?? (() => `pi-inprocess-preflight:${randomUUID()}`);
    this.#maxRetained = options.maxRetainedContinuations ?? 8;
    if (!Number.isInteger(this.#maxRetained) || this.#maxRetained < 1) {
      throw new Error("maxRetainedContinuations must be a positive integer.");
    }
  }

  preflight(input: BackendPreflightInput): BackendPreflightResult {
    const { diagnostics, model } = evaluateInProcessIntent(
      input.intent,
      this.#modelRegistry,
      PI_INPROCESS_BACKEND_ID,
    );
    const preflightId = this.#idFactory();
    if (
      input.intent.continuation?.id !== undefined &&
      !this.#retained.has(input.intent.continuation.id)
    ) {
      diagnostics.push({
        level: "error",
        code: "pi-inprocess.continuation-missing",
        message: "The continuation handle is unknown to this backend instance.",
        path: "continuation.id",
      });
    }
    const retained = input.intent.continuation?.id
      ? this.#retained.get(input.intent.continuation.id)
      : undefined;
    if (
      input.intent.continuation?.id === undefined &&
      input.intent.continuation?.retain === true &&
      this.#retained.size + this.#retentionReservations.size >= this.#maxRetained
    ) {
      diagnostics.push({
        level: "error",
        code: "pi-inprocess.continuation-limit",
        message: "The in-process continuation retention limit is full.",
        path: "continuation",
      });
    }
    if (retained?.reservedBy !== undefined) {
      diagnostics.push({
        level: "error",
        code: "pi-inprocess.continuation-busy",
        message: "The retained child already has a prepared or executing turn.",
        path: "continuation.id",
      });
    }
    if (
      retained &&
      retained.binding !== continuationBinding(input.intent)
    ) {
      diagnostics.push({
        level: "error",
        code: "pi-inprocess.continuation-binding",
        message: "Continuation configuration changed; prepare a new child.",
        path: "continuation",
      });
    }
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
    const accepted = acceptedInProcessPreflight({
      descriptor: this.descriptor,
      preflightId,
      intent: input.intent,
      model,
      diagnostics,
      codePrefix: PI_INPROCESS_BACKEND_ID,
    });
    if (
      accepted.status === "accepted" &&
      input.intent.continuation?.id === undefined &&
      input.intent.continuation?.retain === true
    ) {
      // This reservation is made before SDK preparation/provider dispatch. It
      // prevents concurrent retained first runs from all doing expensive work
      // and then discovering that only one handle fits the bound.
      this.#retentionReservations.add(preflightId);
    }
    return accepted;
  }

  async prepare(
    input: AcceptedPreparationInput,
    context: BackendPreparationContext,
  ): Promise<BackendPreparation> {
    const continuationId = input.intent.continuation?.id;
    if (!continuationId) {
      try {
        return await this.#preparations.prepare(input, context);
      } catch (error) {
        this.#releaseRetentionReservation(input.preflight.preflightId);
        throw error;
      }
    }
    const retained = this.#retained.get(continuationId);
    if (!retained || (retained.reservedBy !== undefined && retained.reservedBy !== input.preflight.preflightId)) {
      throw new Error("Continuation is already locked by another turn.");
    }
    retained.reservedBy = input.preflight.preflightId;
    try {
      const history = retainedHistory(retained);
      const conversation = await context.compile(
        structuredClone(retained.runtime),
        { history: structuredClone(history) },
      );
      const task = appendedContinuationTask(history, conversation);
      return {
        runtime: structuredClone(retained.runtime),
        conversation,
        state: { kind: "continuation", retained, task } satisfies ContinuationPreparation,
      };
    } catch (error) {
      retained.reservedBy = undefined;
      this.#releaseRetentionReservation(input.preflight.preflightId);
      throw error;
    }
  }

  async start(
    input: BoundExecutionInput,
    context: BackendExecutionContext,
  ): Promise<BackendExecution> {
    const { plan } = input;
    const state = input.preparation.state as
      | PrimedPreparation
      | ContinuationPreparation
      | undefined;
    const continuation =
      state && typeof state === "object" && "kind" in state &&
      state.kind === "continuation"
        ? state
        : undefined;
    const primed = continuation
      ? continuation.retained.primed
      : state && this.#preparations.get(plan.preflightId) === state
        ? state
        : undefined;
    if (!primed) {
      throw new Error("Pi in-process execution has no matching prepared plan.");
    }
    if (canonicalJson(primed.runtime) !== canonicalJson(plan.promptRuntime)) {
      if (continuation) await this.#stopRetained(continuation.retained);
      else await this.#preparations.stop(primed);
      this.#releaseRetentionReservation(plan.preflightId);
      throw new Error(
        "Pi in-process execution plan does not match its prepared prompt.",
      );
    }
    if (
      (!continuation && canonicalJson(primed.conversation) !== canonicalJson(plan.conversation)) ||
      (continuation && continuation.retained.reservedBy !== plan.preflightId)
    ) {
      if (continuation) await this.#stopRetained(continuation.retained);
      else await this.#preparations.stop(primed);
      this.#releaseRetentionReservation(plan.preflightId);
      throw new Error("Pi in-process execution plan does not match its approved history.");
    }
    // Ownership transfer for a first run. A continuation keeps the retained
    // session owned by the backend until this turn either succeeds or retires it.
    if (!continuation) this.#preparations.take(plan.preflightId);

    let effectiveToolNames: string[];
    let report: ProcessRunReport;
    try {
      effectiveToolNames = plan.effectiveTools.map(
        (tool) => tool.backendToolName,
      );
      report = createProcessReport({
      preparedRunId: plan.preparedRunId,
      executionFingerprint: plan.executionFingerprint,
      model: plan.preflight.model,
      ...(plan.preflight.thinkingLevel === undefined
        ? {}
        : { thinkingLevel: plan.preflight.thinkingLevel }),
      effectiveToolNames,
      workingDirectory: this.#cwd,
        startedAt: this.#now().toISOString(),
        executionBoundary: "shared-user",
      });
      this.#reports.set(plan.preparedRunId, report);
      context.emit({
        phase: "starting",
        message: `Starting in-process run with ${effectiveToolNames.join(", ") || "no tools"}.`,
        details: processReportSummary(report),
      });
    } catch (error) {
      // Ownership already transferred: clean up here, because discard() can no
      // longer see this preparation in the gate.
      this.#releaseRetentionReservation(plan.preflightId);
      await this.#cleanupRun(plan.preparedRunId, primed, continuation?.retained);
      throw error;
    }

    let unsubscribe: (() => void) | undefined;
    try {
      const active: ActiveInProcessRun = {
        session: primed.session,
        ...(continuation ? { retained: continuation.retained } : {}),
        forceSettle: deferred<void>(),
      };
      this.#active.set(plan.preparedRunId, active);

      unsubscribe = primed.session.subscribe((event) => {
        if (event.type !== "message_end") return;
        const message = sanitizeSubprocessReportValue(event.message);
        captureProcessAssistantReceipt(report, message);
        appendProcessReportMessage(
          report,
          message,
          sanitizeSubprocessReportValue,
        );
        if (isRecord(message) && message.role === "toolResult") {
          context.emit({
            phase: "tool-result",
            message: processToolResultSummary(message),
            details: processReportSummary(report),
          });
        } else {
          context.emit({
            phase: "message",
            message:
              latestProcessAssistantText(report.messages) ||
              "Subagent completed a model turn.",
            details: processReportSummary(report),
          });
        }
      });
    } catch (error) {
      // Ownership already transferred: clean up here, because discard() can no
      // longer see this preparation in the gate.
      this.#releaseRetentionReservation(plan.preflightId);
      await this.#cleanupRun(plan.preparedRunId, primed, continuation?.retained);
      throw error;
    }
    const active = this.#active.get(plan.preparedRunId)!;

    const abort = () => {
      void this.#terminateRun(plan.preparedRunId, abortReason(context.signal));
    };
    if (context.signal.aborted) abort();
    else context.signal.addEventListener("abort", abort, { once: true });

    const result = (async (): Promise<BackendResult> => {
      let executionError: unknown;
      try {
        // A continuation gets a fresh gate and a real user prompt. The bridge
        // still substitutes only the original frozen conversation; accumulated
        // assistant/tool messages remain in the same AgentSession transcript.
        if (continuation) {
          // Rearming creates the gate for this exact approved turn. Release
          // that gate before starting the prompt; otherwise the provider
          // request waits forever on the newly-created deferred.
          const providerGate = primed.rearmProviderGate();
          providerGate.resolve();
          primed.startTurn(continuation.task);
        } else {
          primed.providerGate.resolve();
        }
        // A non-cooperative provider may ignore abort; a bounded termination
        // resolves forceSettle so this run still reaches a terminal result.
        await Promise.race([primed.execution, active.forceSettle.promise]);
      } catch (error) {
        executionError = error;
      }
      context.signal.removeEventListener("abort", abort);
      unsubscribe?.();
      const terminal = this.#terminalResult(plan, report, active, context, executionError);
      const retain = terminal.status === "completed" && plan.intent.continuation?.retain === true;
      if (retain) {
        try {
          const retained = continuation?.retained ?? this.#newRetained(primed, plan);
          if (continuation) retained.reservedBy = undefined;
          this.#retained.set(retained.id, retained);
          this.#active.delete(plan.preparedRunId);
          const continuationId = retained.id;
          return { ...terminal, continuationId };
        } catch (error) {
          // A retention allocation or terminal event failure must not leave a
          // live session detached from either the active-run or retained maps.
          this.#releaseRetentionReservation(plan.preflightId);
          try {
            await this.#cleanupRun(plan.preparedRunId, primed, continuation?.retained);
          } catch (cleanupError) {
            error = new AggregateError([error, cleanupError]);
          }
          return this.#failedBackendResult(plan, error, report);
        }
      }
      this.#releaseRetentionReservation(plan.preflightId);
      try {
        await this.#cleanupRun(plan.preparedRunId, primed, continuation?.retained);
      } catch (cleanupError) {
        return this.#failedBackendResult(plan, cleanupError, report);
      }
      return terminal;
    })().catch(async (error): Promise<BackendResult> => {
      // Includes context.emit failures from terminal reporting. The result
      // promise must settle only after the session and any capacity
      // reservation have been cleaned up.
      this.#releaseRetentionReservation(plan.preflightId);
      try {
        await this.#cleanupRun(plan.preparedRunId, primed, continuation?.retained);
      } catch (cleanupError) {
        error = new AggregateError([error, cleanupError]);
      }
      return this.#failedBackendResult(plan, error, report);
    });

    return {
      result,
      cancel: async (reason) => {
        await this.#terminateRun(plan.preparedRunId, reason);
      },
      dispose: async () => {
        await this.#terminateRun(
          plan.preparedRunId,
          "In-process execution disposed.",
        );
        await result.catch(() => undefined);
      },
    };
  }

  /** Runtime-internal rollback for accepted preflights cancelled before prepare. */
  releasePreflightReservation(preflightId: string): void {
    this.#releaseRetentionReservation(preflightId);
  }

  async discard(preparation: BackendPreparation): Promise<void> {
    const state = preparation.state as PrimedPreparation | ContinuationPreparation | undefined;
    if (state && typeof state === "object" && "kind" in state && state.kind === "continuation") {
      state.retained.reservedBy = undefined;
      return;
    }
    const primed = state as PrimedPreparation | undefined;
    if (!primed || this.#preparations.get(primed.preflightId) !== primed) {
      if (primed) this.#releaseRetentionReservation(primed.preflightId);
      return;
    }
    this.#releaseRetentionReservation(primed.preflightId);
    await this.#preparations.stop(primed);
  }

  async releaseContinuation(id: string): Promise<void> {
    const retained = this.#retained.get(id);
    if (!retained) return;
    if (retained.reservedBy !== undefined) {
      throw new Error("Cannot release a continuation with a prepared turn.");
    }
    await this.#stopRetained(retained);
  }

  /**
   * Returns the sanitized retained report for a finished run and removes it
   * from the backend. Reports are keyed by preparedRunId because a prepared
   * handle executes at most once.
   */
  takeReport(preparedRunId: string): PiInProcessRunReport | undefined {
    const report = this.#reports.get(preparedRunId);
    if (!report) return undefined;
    this.#reports.delete(preparedRunId);
    return sanitizeProcessRunReport(report, sanitizeSubprocessReportValue);
  }

  /** Backend-level cleanup: stops preparations and aborts active runs. */
  async dispose(): Promise<void> {
    const cleanup = [
      this.#preparations.stopAll(),
      ...[...this.#active.keys()].map((preparedRunId) =>
        this.#terminateRun(preparedRunId, "In-process backend disposed."),
      ),
      ...[...this.#retained.values()].map((retained) =>
        this.#stopRetained(retained),
      ),
    ];
    const outcomes = await Promise.allSettled(cleanup);
    this.#retentionReservations.clear();
    this.#active.clear();
    this.#reports.clear();
    const failures = outcomes
      .filter(
        (outcome): outcome is PromiseRejectedResult =>
          outcome.status === "rejected",
      )
      .map(({ reason }) => reason);
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        "In-process backend cleanup encountered failures.",
      );
    }
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
    // Bounded escalation: a non-cooperative provider stream or tool can ignore
    // the abort signal, and neither cancel() nor dispose() may hang on it.
    active.termination ??= (async () => {
      await Promise.race([
        active.session.abort().catch(() => undefined),
        new Promise<void>((resolve) => setTimeout(resolve, TERMINATE_GRACE_MS)),
      ]);
      // The provider did not cooperate within the grace period; release the
      // result promise so the run can still settle as terminated.
      active.forceSettle.resolve();
    })();
    await active.termination;
  }

  #newRetained(
    primed: PrimedPreparation,
    plan: SealedPlanSnapshot,
  ): RetainedContinuation {
    if (!this.#retentionReservations.has(plan.preflightId)) {
      throw new Error("The in-process continuation retention reservation is missing.");
    }
    const retained: RetainedContinuation = {
      id: `pi-continuation:${randomUUID()}`,
      primed,
      binding: continuationBinding(plan.intent),
      runtime: structuredClone(primed.runtime),
      conversation: structuredClone(primed.conversation),
      reservedBy: undefined,
    };
    // Consume only after construction succeeds; a clone/id failure leaves the
    // capacity reservation available for cleanup/retry rather than leaking it.
    this.#retentionReservations.delete(plan.preflightId);
    return retained;
  }

  #releaseRetentionReservation(preflightId: string): void {
    this.#retentionReservations.delete(preflightId);
  }

  #failedBackendResult(
    plan: SealedPlanSnapshot,
    error: unknown,
    report?: ProcessRunReport,
  ): BackendResult {
    const message = error instanceof Error ? error.message : String(error);
    if (report) report.status = "failed";
    const output = report ? latestProcessAssistantText(report.messages) : undefined;
    return {
      status: "failed",
      error: { code: "inprocess-cleanup", message, retryable: false },
      enforcement: {
        access: structuredClone(plan.preflight.access),
        limits: structuredClone(plan.preflight.limits),
      },
      ...(output ? { output: { text: output, partial: true } } : {}),
    };
  }

  async #stopRetained(retained: RetainedContinuation): Promise<void> {
    try {
      await this.#preparations.stop(retained.primed);
    } catch (error) {
      retained.reservedBy = undefined;
      throw error;
    }
    this.#retire(retained);
  }

  #retire(retained: RetainedContinuation): void {
    if (this.#retained.get(retained.id) === retained) {
      this.#retained.delete(retained.id);
    }
    retained.reservedBy = undefined;
  }

  async #cleanupRun(
    preparedRunId: string,
    primed: PrimedPreparation,
    retained?: RetainedContinuation,
  ): Promise<void> {
    // Delegate to the gate so the parked execution settles (provider gate
    // rejected, transport stopped) instead of leaking a pending promise.
    try {
      await this.#preparations.stop(primed);
    } catch (error) {
      if (retained) retained.reservedBy = undefined;
      throw error;
    }
    if (this.#active.get(preparedRunId)?.session === primed.session) {
      this.#active.delete(preparedRunId);
    }
    if (retained) this.#retire(retained);
  }

  #terminalResult(
    plan: SealedPlanSnapshot,
    report: ProcessRunReport,
    active: ActiveInProcessRun,
    context: BackendExecutionContext,
    executionError: unknown,
  ): BackendResult {
    report.finishedAt = this.#now().toISOString();
    const output = latestProcessAssistantText(report.messages);
    const enforcement: EnforcementReceipt = {
      access: structuredClone(plan.preflight.access),
      limits: structuredClone(plan.preflight.limits),
    };
    const usage = processRunUsage(report.usage);

    if (context.signal.aborted || active.terminationReason) {
      report.status = "cancelled";
      context.emit({
        phase: "finishing",
        message: "Subagent cancelled.",
        details: processReportSummary(report),
      });
      return {
        status: "cancelled",
        reason: active.terminationReason ?? abortReason(context.signal),
        enforcement,
        ...(usage ? { usage } : {}),
        ...(output ? { output: { text: output, partial: true } } : {}),
      };
    }
    if (
      executionError ||
      report.stopReason === "error" ||
      report.stopReason === "aborted" ||
      report.errorMessage
    ) {
      report.status = "failed";
      const message =
        report.errorMessage ||
        (executionError instanceof Error
          ? executionError.message
          : executionError
            ? String(executionError)
            : "Pi in-process run failed.");
      context.emit({
        phase: "finishing",
        message: `Subagent failed: ${message}`,
        details: processReportSummary(report),
      });
      return {
        status: "failed",
        error: { code: "inprocess", message, retryable: false },
        enforcement,
        ...(usage ? { usage } : {}),
        ...(output ? { output: { text: output, partial: true } } : {}),
      };
    }
    if (!output) {
      report.status = "failed";
      report.errorMessage = "Pi in-process run produced no assistant report.";
      context.emit({
        phase: "finishing",
        message: "Subagent failed: no assistant report.",
        details: processReportSummary(report),
      });
      return {
        status: "failed",
        error: {
          code: "inprocess-empty",
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
      details: processReportSummary(report),
    });
    return {
      status: "completed",
      output: { text: output, partial: false },
      enforcement,
      ...(usage ? { usage } : {}),
    };
  }
}

export function sanitizePiInProcessRunReport(
  report: PiInProcessRunReport,
): PiInProcessRunReport {
  return sanitizeProcessRunReport(report, sanitizeSubprocessReportValue);
}

function continuationBinding(intent: SealedPlanSnapshot["intent"]): string {
  const { continuation: _continuation, ...stable } = intent;
  return fingerprint(stable);
}

function retainedHistory(retained: RetainedContinuation): PreparedConversation {
  const messages = [...retained.conversation.messages];
  const sessionMessages = (retained.primed.session as unknown as { messages?: unknown[] }).messages;
  if (!Array.isArray(sessionMessages)) {
    throw new Error("Retained session history is unavailable; refusing to continue.");
  }
  const trigger = "Prepare the subagent prompt runtime without contacting the provider.";
  const triggerIndex = sessionMessages.findIndex((message) =>
    isTriggerAgentMessage(message, trigger),
  );
  if (triggerIndex < 0) {
    // This is also the compaction/folding failure mode: the bridge can no
    // longer locate the original trigger and would otherwise silently submit
    // only the original compiled prefix for approval.
    throw new Error(
      "Retained session preparation trigger is missing; refusing to continue after context compaction.",
    );
  }
  for (const message of sessionMessages.slice(triggerIndex + 1)) {
    messages.push(agentMessageToPrepared(message));
  }
  return { systemPrompt: retained.conversation.systemPrompt, messages };
}

function appendedContinuationTask(
  history: PreparedConversation,
  conversation: PreparedConversation,
): string {
  if (conversation.systemPrompt !== history.systemPrompt) {
    throw new Error("Continuation changed the frozen system prompt; prepare a new child.");
  }
  if (conversation.messages.length !== history.messages.length + 1) {
    throw new Error(
      "Continuation approval must contain the complete retained history plus exactly one new task.",
    );
  }
  for (let index = 0; index < history.messages.length; index += 1) {
    if (canonicalJson(conversation.messages[index]) !== canonicalJson(history.messages[index])) {
      throw new Error("Continuation approval changed retained history; prepare a new child.");
    }
  }
  const task = conversation.messages[conversation.messages.length - 1];
  if (!task || task.role !== "user") {
    throw new Error("Continuation approval must append a user task.");
  }
  if (task.content.length !== 1 || task.content[0]?.type !== "text") {
    throw new Error(
      "Continuation task must contain exactly one plain text content part.",
    );
  }
  const text = task.content[0].text;
  if (!text.trim()) throw new Error("Continuation task must not be empty.");
  return text;
}

function isTriggerAgentMessage(message: unknown, trigger: string): boolean {
  if (!message || typeof message !== "object" || (message as { role?: unknown }).role !== "user") return false;
  const content = (message as { content?: unknown }).content;
  return content === trigger || (
    Array.isArray(content) && content.length === 1 &&
    (content[0] as { type?: unknown; text?: unknown })?.type === "text" &&
    (content[0] as { text?: unknown }).text === trigger
  );
}

function agentMessageToPrepared(message: unknown): PreparedMessage {
  if (!message || typeof message !== "object") {
    throw new Error("Retained session history contains a malformed native message.");
  }
  // Approval/hash history is deliberately a lossless canonical envelope. It
  // is not fed back into the native session; the SDK transcript remains the
  // authoritative execution history. Keeping the full native object here
  // preserves thinking blocks, toolCallId, media, and top-level metadata.
  return {
    role: "custom",
    content: [{ type: "text", text: canonicalJson(message) }],
  };
}

function abortReason(signal: AbortSignal): string {
  return typeof signal.reason === "string" && signal.reason
    ? signal.reason
    : "In-process execution cancelled.";
}
