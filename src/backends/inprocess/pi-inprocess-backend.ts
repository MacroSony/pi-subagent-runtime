import { rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  canonicalJson,
  type BackendDescriptor,
  type BackendPreflightResult,
  type EnforcementReceipt,
  type SealedPlanSnapshot,
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
}

const TERMINATE_GRACE_MS = 3_000;

interface ActiveInProcessRun {
  session: PrimedPreparation["session"];
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
  }

  preflight(input: BackendPreflightInput): BackendPreflightResult {
    const { diagnostics, model } = evaluateInProcessIntent(
      input.intent,
      this.#modelRegistry,
      PI_INPROCESS_BACKEND_ID,
    );
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
    return acceptedInProcessPreflight({
      descriptor: this.descriptor,
      preflightId,
      intent: input.intent,
      model,
      diagnostics,
      codePrefix: PI_INPROCESS_BACKEND_ID,
    });
  }

  async prepare(
    input: AcceptedPreparationInput,
    context: BackendPreparationContext,
  ): Promise<BackendPreparation> {
    return this.#preparations.prepare(input, context);
  }

  async start(
    input: BoundExecutionInput,
    context: BackendExecutionContext,
  ): Promise<BackendExecution> {
    const { plan } = input;
    const primedState = input.preparation.state as PrimedPreparation | undefined;
    const primed =
      primedState && this.#preparations.get(plan.preflightId) === primedState
        ? primedState
        : undefined;
    if (!primed) {
      throw new Error("Pi in-process execution has no matching prepared plan.");
    }
    if (
      canonicalJson(primed.runtime) !== canonicalJson(plan.promptRuntime) ||
      canonicalJson(primed.conversation) !== canonicalJson(plan.conversation)
    ) {
      await this.#preparations.stop(primed);
      throw new Error(
        "Pi in-process execution plan does not match its prepared prompt.",
      );
    }
    // Ownership transfer: from here this backend owns the session, the
    // provider gate, the execution promise, and tempDir cleanup.
    this.#preparations.take(plan.preflightId);

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
      await this.#cleanupRun(plan.preparedRunId, primed);
      throw error;
    }

    let unsubscribe: (() => void) | undefined;
    try {
      const active: ActiveInProcessRun = {
        session: primed.session,
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
      await this.#cleanupRun(plan.preparedRunId, primed);
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
        // Release the parked provider request; the sealed conversation now
        // executes in this process against the host model runtime.
        primed.providerGate.resolve();
        // A non-cooperative provider may ignore abort; a bounded termination
        // resolves forceSettle so this run still reaches a terminal result.
        await Promise.race([primed.execution, active.forceSettle.promise]);
      } catch (error) {
        executionError = error;
      } finally {
        context.signal.removeEventListener("abort", abort);
        unsubscribe?.();
        await this.#cleanupRun(plan.preparedRunId, primed);
      }
      return this.#terminalResult(plan, report, active, context, executionError);
    })();

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

  async discard(preparation: BackendPreparation): Promise<void> {
    const primed = preparation.state as PrimedPreparation | undefined;
    if (!primed || this.#preparations.get(primed.preflightId) !== primed) {
      return;
    }
    await this.#preparations.stop(primed);
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
    await this.#preparations.stopAll();
    await Promise.all(
      [...this.#active.keys()].map((preparedRunId) =>
        this.#terminateRun(preparedRunId, "In-process backend disposed."),
      ),
    );
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

  async #cleanupRun(
    preparedRunId: string,
    primed: PrimedPreparation,
  ): Promise<void> {
    this.#active.delete(preparedRunId);
    // Delegate to the gate so the parked execution settles (provider gate
    // rejected, transport stopped) instead of leaking a pending promise.
    await this.#preparations.stop(primed);
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

function abortReason(signal: AbortSignal): string {
  return typeof signal.reason === "string" && signal.reason
    ? signal.reason
    : "In-process execution cancelled.";
}
