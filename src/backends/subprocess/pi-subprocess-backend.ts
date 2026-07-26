import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import type { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
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
  BackendPreparation,
  BackendPreparationContext,
  BackendPreflightInput,
  BackendResult,
  BoundExecutionInput,
  ExecutionBackend,
} from "../../runtime/index.ts";
import {
  SUBPROCESS_BRIDGE_INPUT_ENV,
  type SubprocessBridgeInput,
} from "../shared/process-bridge.ts";
import {
  SUBPROCESS_REPORT_FD_ENV,
  sanitizeSubprocessReportValue,
} from "../shared/report-sanitize.ts";
import {
  acceptedReadOnlyPreflight,
  evaluateProcessIntent,
} from "../shared/preflight-policy.ts";
import {
  MAX_PROCESS_STDERR_BYTES,
  MAX_RETAINED_PROCESS_REPORT_BYTES,
  appendBounded,
  appendProcessReportMessage,
  captureProcessAssistantReceipt,
  createProcessReport,
  isRecord,
  latestProcessAssistantText,
  processReportSummary,
  processRunUsage,
  processToolResultSummary,
  sanitizeProcessRunReport,
  type ProcessRunReport,
  type ProcessRunUsage,
} from "../shared/process-report.ts";
import {
  SdkPreparationGate,
  type PrimedPreparation,
} from "../shared/sdk-preparation.ts";

export const PI_SUBPROCESS_READONLY_BACKEND_ID = "pi-subprocess-readonly";
export const PI_SUBPROCESS_READONLY_BACKEND_DESCRIPTOR: BackendDescriptor = {
  id: PI_SUBPROCESS_READONLY_BACKEND_ID,
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

export type PiSubprocessUsage = ProcessRunUsage;
export type PiSubprocessRunReport = ProcessRunReport;
export const MAX_RETAINED_SUBPROCESS_REPORT_BYTES =
  MAX_RETAINED_PROCESS_REPORT_BYTES;

const MAX_STDOUT_BYTES = 8 * 1024 * 1024;
const MAX_REPORT_STREAM_BYTES = 8 * 1024 * 1024;
const TERMINATE_GRACE_MS = 5_000;

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
  env?: Readonly<Record<string, string>>;
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
  readonly #preparations: SdkPreparationGate;
  readonly #cwd: string;
  readonly #now: () => Date;
  readonly #idFactory: () => string;
  readonly #invocationFactory: (piArgs: string[]) => PiInvocation;
  readonly #bridgePath: string;
  readonly #env?: Readonly<Record<string, string>>;
  readonly #modelRegistry: ModelRegistry;
  readonly #active = new Map<string, ActiveSubprocessRun>();
  readonly #reports = new Map<string, PiSubprocessRunReport>();

  constructor(options: PiSubprocessBackendOptions) {
    this.#modelRegistry = options.modelRegistry;
    this.#preparations = new SdkPreparationGate({
      modelRegistry: options.modelRegistry,
      ...(options.modelRuntime ? { modelRuntime: options.modelRuntime } : {}),
      cwd: options.cwd,
      ...(options.now ? { now: options.now } : {}),
    });
    this.#cwd = options.cwd;
    this.#now = options.now ?? (() => new Date());
    this.#idFactory =
      options.idFactory ?? (() => `pi-subprocess-preflight:${randomUUID()}`);
    this.#invocationFactory = options.invocationFactory ?? defaultPiInvocation;
    this.#bridgePath = options.bridgePath ?? defaultBridgePath();
    if (options.env) this.#env = options.env;
  }

  preflight(input: BackendPreflightInput): BackendPreflightResult {
    const { diagnostics, model } = evaluateProcessIntent(
      input.intent,
      this.#modelRegistry,
      "pi-subprocess",
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
    return acceptedReadOnlyPreflight({
      descriptor: this.descriptor,
      preflightId,
      intent: input.intent,
      model,
      diagnostics,
      codePrefix: "pi-subprocess",
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
    const primed = requirePrimed(this.#preparations, input.preparation, plan.preflightId);
    if (
      canonicalJson(primed.runtime) !== canonicalJson(plan.promptRuntime) ||
      canonicalJson(primed.conversation) !== canonicalJson(plan.conversation)
    ) {
      await this.#preparations.stop(primed);
      throw new Error(
        "Pi subprocess execution plan does not match its prepared prompt.",
      );
    }
    await this.#preparations.stop(primed);
    const effectiveToolNames = plan.effectiveTools.map(
      (tool) => tool.backendToolName,
    );
    const report = createProcessReport({
      preparedRunId: plan.preparedRunId,
      executionFingerprint: plan.executionFingerprint,
      model: plan.preflight.model,
      ...(plan.preflight.thinkingLevel === undefined
        ? {}
        : { thinkingLevel: plan.preflight.thinkingLevel }),
      effectiveToolNames,
      workingDirectory: this.#cwd,
      startedAt: this.#now().toISOString(),
    });
    this.#reports.set(plan.preparedRunId, report);
    context.emit({
      phase: "starting",
      message: `Starting subprocess run with ${effectiveToolNames.join(", ") || "no tools"}.`,
      details: processReportSummary(report),
    });

    const runDir = mkdtempSync(join(tmpdir(), "pi-subagent-runtime-run-"));
    let child: ChildProcess;
    try {
      const bridgeInput = createBridgeInput(plan, effectiveToolNames);
      const inputPath = join(runDir, "bridge-input.json");
      const systemPromptPath = join(runDir, "system-prompt.md");
      writeFileSync(inputPath, JSON.stringify(bridgeInput), {
        encoding: "utf8",
        mode: 0o600,
      });
      writeFileSync(systemPromptPath, plan.conversation.systemPrompt, {
        encoding: "utf8",
        mode: 0o600,
      });
      const piArgs = subprocessArguments(
        plan,
        effectiveToolNames,
        this.#bridgePath,
        systemPromptPath,
        bridgeInput.marker,
      );
      const invocation = this.#invocationFactory(piArgs);
      child = spawn(invocation.command, invocation.args, {
        cwd: this.#cwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          ...this.#env,
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
  takeReport(preparedRunId: string): PiSubprocessRunReport | undefined {
    const report = this.#reports.get(preparedRunId);
    if (!report) return undefined;
    this.#reports.delete(preparedRunId);
    return sanitizeProcessRunReport(report, sanitizeSubprocessReportValue);
  }

  /** Backend-level cleanup: stops preparations and terminates active runs. */
  async dispose(): Promise<void> {
    await this.#preparations.stopAll();
    await Promise.all(
      [...this.#active.keys()].map((preparedRunId) =>
        this.#terminateRun(preparedRunId, "Subprocess backend disposed."),
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
    active.termination ??= terminateChild(active.child);
    await active.termination;
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
        const message = sanitizeSubprocessReportValue(event.message);
        captureProcessAssistantReceipt(report, message);
        appendProcessReportMessage(report, message, sanitizeSubprocessReportValue);
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
        if (Buffer.byteLength(report.stderr, "utf8") >= MAX_PROCESS_STDERR_BYTES) {
          return;
        }
        report.stderr = appendBounded(
          report.stderr,
          chunk.toString("utf8"),
          MAX_PROCESS_STDERR_BYTES,
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
}

function requirePrimed(
  gate: SdkPreparationGate,
  preparation: BackendPreparation,
  preflightId: string,
): PrimedPreparation {
  const primed = preparation.state as PrimedPreparation | undefined;
  if (!primed || gate.get(preflightId) !== primed || primed.disposed) {
    throw new Error("Pi subprocess execution has no matching prepared plan.");
  }
  return primed;
}

function terminalResult(
  plan: SealedPlanSnapshot,
  report: PiSubprocessRunReport,
  active: ActiveSubprocessRun,
  context: BackendExecutionContext,
  outcome: { code: number | null; spawnError?: Error },
): BackendResult {
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
      details: processReportSummary(report),
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
      details: processReportSummary(report),
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
    details: processReportSummary(report),
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
  return sanitizeProcessRunReport(report, sanitizeSubprocessReportValue);
}

function createBridgeInput(
  plan: SealedPlanSnapshot,
  effectiveToolNames: readonly string[],
): SubprocessBridgeInput {
  return {
    marker: `PI_SUBAGENT_RUNTIME_MARKER_${randomUUID()}`,
    systemPrompt: plan.conversation.systemPrompt,
    messages: plan.conversation.messages,
    model: plan.preflight.model,
    effectiveToolNames,
  };
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

function abortReason(signal: AbortSignal): string {
  return typeof signal.reason === "string" && signal.reason
    ? signal.reason
    : "Subprocess execution cancelled.";
}
