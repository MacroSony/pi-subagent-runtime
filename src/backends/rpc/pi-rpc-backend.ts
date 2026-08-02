import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Readable } from "node:stream";
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
import type { PiModelRegistry } from "../shared/pi-model-runtime.ts";
import {
  MAX_PROCESS_STDERR_BYTES,
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
} from "../shared/process-report.ts";
import {
  SdkPreparationGate,
  type PrimedPreparation,
} from "../shared/sdk-preparation.ts";
import { PiRpcClient, type PiRpcRecord } from "./rpc-client.ts";

export const PI_RPC_READONLY_BACKEND_ID = "pi-rpc-readonly";
export const PI_RPC_READONLY_BACKEND_DESCRIPTOR: BackendDescriptor = {
  id: PI_RPC_READONLY_BACKEND_ID,
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

export type PiRpcRunReport = ProcessRunReport;
export type PiRpcUsage = ProcessRunReport["usage"];

const MAX_REPORT_STREAM_BYTES = 8 * 1024 * 1024;
const TERMINATE_GRACE_MS = 5_000;
const EOF_GRACE_MS = 2_000;
const DEFAULT_ABORT_SETTLE_MS = 2_000;

interface PiInvocation {
  command: string;
  args: string[];
}

export interface PiRpcBackendOptions {
  modelRegistry: PiModelRegistry;
  modelRuntime?: ModelRuntime;
  cwd: string;
  now?: () => Date;
  idFactory?: () => string;
  invocationFactory?: (piArgs: string[]) => PiInvocation;
  bridgePath?: string;
  env?: Readonly<Record<string, string>>;
  /** Bounded wait for the RPC abort command to settle before SIGTERM. */
  abortSettleMs?: number;
}

/**
 * Fresh-process Pi RPC backend. Preparation shares the adapter-private Pi
 * SDK gate with the subprocess backend, and execution launches a fresh
 * `pi --mode rpc` process with the same trusted bridge: the unique marker
 * prompt is sent over RPC and replaced by the sealed ordered conversation
 * before the first provider request.
 *
 * The first implementation deliberately omits process pooling, session
 * resume/fork/clone, steering, and post-launch plan changes.
 */
export class PiRpcBackend implements ExecutionBackend {
  readonly descriptor: BackendDescriptor = structuredClone(
    PI_RPC_READONLY_BACKEND_DESCRIPTOR,
  );
  readonly #preparations: SdkPreparationGate;
  readonly #modelRegistry: PiModelRegistry;
  readonly #cwd: string;
  readonly #now: () => Date;
  readonly #idFactory: () => string;
  readonly #invocationFactory: (piArgs: string[]) => PiInvocation;
  readonly #bridgePath: string;
  readonly #env?: Readonly<Record<string, string>>;
  readonly #abortSettleMs: number;
  readonly #active = new Map<string, RpcRunController>();
  readonly #reports = new Map<string, PiRpcRunReport>();

  constructor(options: PiRpcBackendOptions) {
    this.#modelRegistry = options.modelRegistry;
    this.#preparations = new SdkPreparationGate({
      modelRegistry: options.modelRegistry,
      ...(options.modelRuntime ? { modelRuntime: options.modelRuntime } : {}),
      cwd: options.cwd,
      ...(options.now ? { now: options.now } : {}),
      tempDirPrefix: "pi-subagent-runtime-rpc-prepare-",
    });
    this.#cwd = options.cwd;
    this.#now = options.now ?? (() => new Date());
    this.#idFactory =
      options.idFactory ?? (() => `pi-rpc-preflight:${randomUUID()}`);
    this.#invocationFactory = options.invocationFactory ?? defaultPiInvocation;
    this.#bridgePath = options.bridgePath ?? defaultBridgePath();
    if (options.env) this.#env = options.env;
    this.#abortSettleMs = options.abortSettleMs ?? DEFAULT_ABORT_SETTLE_MS;
  }

  preflight(input: BackendPreflightInput): BackendPreflightResult {
    const { diagnostics, model } = evaluateProcessIntent(
      input.intent,
      this.#modelRegistry,
      "pi-rpc",
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
      codePrefix: "pi-rpc",
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
    const primed = input.preparation.state as PrimedPreparation | undefined;
    if (
      !primed ||
      this.#preparations.get(plan.preflightId) !== primed ||
      primed.disposed
    ) {
      throw new Error("Pi RPC execution has no matching prepared plan.");
    }
    if (
      canonicalJson(primed.runtime) !== canonicalJson(plan.promptRuntime) ||
      canonicalJson(primed.conversation) !== canonicalJson(plan.conversation)
    ) {
      await this.#preparations.stop(primed);
      throw new Error("Pi RPC execution plan does not match its prepared prompt.");
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
      message: `Starting RPC run with ${effectiveToolNames.join(", ") || "no tools"}.`,
      details: processReportSummary(report),
    });

    const runDir = mkdtempSync(join(tmpdir(), "pi-subagent-runtime-rpc-"));
    let child: ChildProcess;
    let bridgeInput: SubprocessBridgeInput;
    try {
      bridgeInput = {
        marker: `PI_SUBAGENT_RUNTIME_MARKER_${randomUUID()}`,
        systemPrompt: plan.conversation.systemPrompt,
        messages: plan.conversation.messages,
        model: plan.preflight.model,
        effectiveToolNames,
      };
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
      const piArgs = rpcArguments(
        plan,
        effectiveToolNames,
        this.#bridgePath,
        systemPromptPath,
      );
      const invocation = this.#invocationFactory(piArgs);
      child = spawn(invocation.command, invocation.args, {
        cwd: this.#cwd,
        shell: false,
        stdio: ["pipe", "pipe", "pipe", "pipe"],
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

    const controller = new RpcRunController({
      child,
      plan,
      report,
      context,
      runDir,
      marker: bridgeInput.marker,
      abortSettleMs: this.#abortSettleMs,
      now: this.#now,
      onSettled: () => {
        this.#active.delete(plan.preparedRunId);
      },
    });
    this.#active.set(plan.preparedRunId, controller);
    return {
      result: controller.result,
      cancel: (reason) => controller.cancel(reason),
      dispose: () => controller.dispose(),
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
  takeReport(preparedRunId: string): PiRpcRunReport | undefined {
    const report = this.#reports.get(preparedRunId);
    if (!report) return undefined;
    this.#reports.delete(preparedRunId);
    return sanitizeProcessRunReport(report, sanitizeSubprocessReportValue);
  }

  /** Backend-level cleanup: stops preparations and terminates active runs. */
  async dispose(): Promise<void> {
    await this.#preparations.stopAll();
    await Promise.all(
      [...this.#active.values()].map((controller) =>
        controller.cancel("Subagent RPC backend disposed."),
      ),
    );
    this.#active.clear();
    this.#reports.clear();
  }
}

interface RpcRunControllerOptions {
  child: ChildProcess;
  plan: SealedPlanSnapshot;
  report: PiRpcRunReport;
  context: BackendExecutionContext;
  runDir: string;
  marker: string;
  abortSettleMs: number;
  now: () => Date;
  onSettled: () => void;
}

type RpcRunState = "starting" | "running" | "settling" | "settled";

/**
 * Owns one RPC child from spawn to terminal settlement. The result settles
 * exactly once: after agent_settled plus process teardown, after an
 * unexpected close, or after cancellation escalates from the RPC abort
 * command to TERM/KILL.
 */
class RpcRunController {
  readonly result: Promise<BackendResult>;
  readonly #plan: SealedPlanSnapshot;
  readonly #report: PiRpcRunReport;
  readonly #context: BackendExecutionContext;
  readonly #runDir: string;
  readonly #abortSettleMs: number;
  readonly #now: () => Date;
  readonly #onSettled: () => void;
  readonly #child: ChildProcess;
  readonly #client: PiRpcClient;
  #state: RpcRunState = "starting";
  #settle!: (result: BackendResult) => void;
  #terminationReason?: string;
  #termination?: Promise<void>;
  #cancelWaiter?: Promise<void>;
  #disposed = false;

  constructor(options: RpcRunControllerOptions) {
    this.#plan = options.plan;
    this.#report = options.report;
    this.#context = options.context;
    this.#runDir = options.runDir;
    this.#abortSettleMs = options.abortSettleMs;
    this.#now = options.now;
    this.#onSettled = options.onSettled;
    this.#child = options.child;
    this.result = new Promise<BackendResult>((resolve) => {
      this.#settle = resolve;
    });

    let reportBytes = 0;
    const failStream = (message: string): void => {
      if (!this.#report.errorMessage) this.#report.errorMessage = message;
      void this.#terminate();
    };
    const reportStream = this.#child.stdio[3] as Readable | null;
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
      attachStrictLfLines(reportStream, (line) => {
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
          captureProcessAssistantReceipt(this.#report, message);
          appendProcessReportMessage(
            this.#report,
            message,
            sanitizeSubprocessReportValue,
          );
        }
      });
    }
    const stderr = this.#child.stderr;
    if (!stderr) {
      failStream("Subprocess error output channel was unavailable.");
    } else {
      stderr.on("data", (chunk: Buffer) => {
        if (
          Buffer.byteLength(this.#report.stderr, "utf8") >=
          MAX_PROCESS_STDERR_BYTES
        ) {
          return;
        }
        this.#report.stderr = appendBounded(
          this.#report.stderr,
          chunk.toString("utf8"),
          MAX_PROCESS_STDERR_BYTES,
        );
      });
    }

    this.#client = new PiRpcClient(this.#child, {
      onEvent: (record) => this.#onRpcEvent(record),
      onProtocolError: (message) => failStream(message),
    });

    const abort = () => {
      void this.cancel(abortReason(this.#context.signal));
    };
    if (this.#context.signal.aborted) queueMicrotask(abort);
    else {
      this.#context.signal.addEventListener("abort", abort, { once: true });
    }
    this.#removeAbortListener = () =>
      this.#context.signal.removeEventListener("abort", abort);

    this.#child.once("error", (error) => {
      this.#report.errorMessage = error.message;
      this.#onClose(null, null);
    });
    this.#child.once("close", (code, signal) => this.#onClose(code, signal));

    void this.#sendMarker(options.marker);
  }

  #removeAbortListener: () => void;

  async #sendMarker(marker: string): Promise<void> {
    const response = await this.#client.request({
      type: "prompt",
      message: marker,
    });
    if (this.#state === "settled" || this.#state === "settling") return;
    if (!response.success) {
      this.#failBeforeTransport(
        response.error ?? "Pi RPC rejected the marker prompt.",
      );
      return;
    }
    if (this.#state === "starting") this.#state = "running";
  }

  #onRpcEvent(record: PiRpcRecord): void {
    if (record.type === "message_end" && isRecord(record.message)) {
      const message = sanitizeSubprocessReportValue(record.message);
      if (isRecord(message) && message.role === "toolResult") {
        this.#context.emit({
          phase: "tool-result",
          message: processToolResultSummary(message),
          details: processReportSummary(this.#report),
        });
      } else if (isRecord(message) && message.role === "assistant") {
        this.#context.emit({
          phase: "message",
          message:
            assistantTextOf(message) || "Subagent completed a model turn.",
          details: processReportSummary(this.#report),
        });
      }
      return;
    }
    if (record.type === "extension_error") {
      const description = `Pi RPC extension failed during ${String(record.event ?? "unknown event")}: ${String(record.error ?? "unknown error")}`;
      if (!this.#report.errorMessage) this.#report.errorMessage = description;
      return;
    }
    if (record.type === "agent_settled") {
      void this.#finalize();
    }
  }

  /** Terminal path once the agent reports it will not continue on its own. */
  async #finalize(): Promise<void> {
    if (this.#state === "settled" || this.#state === "settling") return;
    this.#state = "settling";
    // Closing stdin ends the RPC session; a fresh pi process exits on EOF.
    this.#client.close();
    await this.#awaitExit(EOF_GRACE_MS);
    await this.#terminate();
  }

  async #awaitExit(graceMs: number): Promise<void> {
    if (this.#child.exitCode !== null || this.#child.signalCode !== null) {
      return;
    }
    const started = Date.now();
    while (
      !this.#isSettled() &&
      this.#child.exitCode === null &&
      this.#child.signalCode === null &&
      Date.now() - started < graceMs
    ) {
      await delay(25);
    }
  }

  #isSettled(): boolean {
    return this.#state === "settled";
  }

  /**
   * Cancels through the documented RPC abort command first, then escalates
   * to process termination if the run does not settle within the bound.
   */
  cancel(reason?: string): Promise<void> {
    if (this.#terminationReason === undefined && reason !== undefined) {
      this.#terminationReason = reason;
    }
    this.#cancelWaiter ??= (async () => {
      if (this.#isSettled()) return;
      const abortResponse = await this.#client.request({ type: "abort" });
      if (
        !abortResponse.success &&
        !this.#isSettled() &&
        this.#state !== "settling"
      ) {
        await this.#terminate();
        return;
      }
      const deadline = Date.now() + this.#abortSettleMs;
      while (!this.#isSettled() && Date.now() < deadline) {
        await delay(25);
      }
      if (!this.#isSettled()) await this.#terminate();
      await this.result.catch(() => undefined);
    })();
    return this.#cancelWaiter;
  }

  /** Idempotent bounded cleanup; the runtime always calls this after settlement. */
  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    if (this.#state !== "settled") {
      await this.cancel("Subagent RPC execution disposed.");
    }
    rmSync(this.#runDir, { recursive: true, force: true });
  }

  #failBeforeTransport(message: string): void {
    if (!this.#report.errorMessage) this.#report.errorMessage = message;
    void this.#finalize();
  }

  #onClose(code: number | null, signal: NodeJS.Signals | null): void {
    if (code !== null) this.#report.exitCode = code;
    if (signal !== null) this.#report.signal = signal;
    if (this.#state === "settled") return;
    this.#client.close();
    if (
      !this.#terminationReason &&
      !this.#report.errorMessage &&
      ((code !== null && code !== 0) || signal !== null)
    ) {
      this.#report.errorMessage =
        signal !== null
          ? `Pi RPC process exited with signal ${signal}.`
          : `Pi RPC process exited with code ${code}.`;
    }
    this.#settleResult();
  }

  async #terminate(): Promise<void> {
    this.#termination ??= (async () => {
      this.#client.close();
      await terminateChild(this.#child);
    })();
    await this.#termination;
  }

  #settleResult(): void {
    if (this.#state === "settled") return;
    this.#state = "settled";
    this.#removeAbortListener();
    rmSync(this.#runDir, { recursive: true, force: true });
    this.#report.finishedAt = this.#now().toISOString();
    this.#onSettled();
    this.#settle(terminalRpcResult(this.#plan, this.#report, this.#context, this.#terminationReason));
  }
}

function terminalRpcResult(
  plan: SealedPlanSnapshot,
  report: PiRpcRunReport,
  context: BackendExecutionContext,
  terminationReason?: string,
): BackendResult {
  const output = latestProcessAssistantText(report.messages);
  const enforcement: EnforcementReceipt = {
    access: structuredClone(plan.preflight.access),
    limits: structuredClone(plan.preflight.limits),
  };
  const usage = processRunUsage(report.usage);

  if (context.signal.aborted || terminationReason) {
    report.status = "cancelled";
    context.emit({
      phase: "finishing",
      message: "Subagent cancelled.",
      details: processReportSummary(report),
    });
    return {
      status: "cancelled",
      reason: terminationReason ?? abortReason(context.signal),
      enforcement,
      ...(usage ? { usage } : {}),
    };
  }
  if (
    report.stopReason === "error" ||
    report.stopReason === "aborted" ||
    report.errorMessage
  ) {
    report.status = "failed";
    const message =
      report.errorMessage ||
      report.stderr.trim() ||
      "Pi RPC run failed before producing a report.";
    context.emit({
      phase: "finishing",
      message: `Subagent failed: ${message}`,
      details: processReportSummary(report),
    });
    return {
      status: "failed",
      error: { code: "pi-rpc", message, retryable: false },
      enforcement,
      ...(usage ? { usage } : {}),
      ...(output ? { output: { text: output, partial: true } } : {}),
    };
  }
  if (!output) {
    report.status = "failed";
    report.errorMessage = "Pi RPC run produced no assistant report.";
    context.emit({
      phase: "finishing",
      message: "Subagent failed: no assistant report.",
      details: processReportSummary(report),
    });
    return {
      status: "failed",
      error: {
        code: "pi-rpc-empty",
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

function rpcArguments(
  plan: SealedPlanSnapshot,
  toolNames: string[],
  bridgePath: string,
  systemPromptPath: string,
): string[] {
  const args = [
    "--mode",
    "rpc",
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
  return args;
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
    "..",
    "shared",
    `process-bridge${extension}`,
  );
}

/** Strict-LF splitter: splits on \n only and strips one trailing \r. */
function attachStrictLfLines(
  stream: Readable,
  onLine: (line: string) => void,
): void {
  let buffer = "";
  stream.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let index: number;
    while ((index = buffer.indexOf("\n")) !== -1) {
      let line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      onLine(line);
    }
  });
  stream.on("end", () => {
    if (buffer.trim()) onLine(buffer);
    buffer = "";
  });
}

function assistantTextOf(value: Record<string, unknown>): string {
  if (!Array.isArray(value.content)) return "";
  return value.content
    .filter(isRecord)
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => String(part.text))
    .join("")
    .trim();
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function abortReason(signal: AbortSignal): string {
  return typeof signal.reason === "string" && signal.reason
    ? signal.reason
    : "Subagent RPC execution cancelled.";
}
