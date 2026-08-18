import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  canonicalJson,
  type BackendDescriptor,
  type BackendPreflightResult,
  type EnforcementReceipt,
  type Fingerprint,
  type SealedPlanSnapshot,
  type WorkspaceChangeSet,
  type WorkspaceProposalReference,
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
import type { PiModelRegistry } from "../shared/pi-model-runtime.ts";
import {
  SdkPreparationGate,
  type PrimedPreparation,
} from "../shared/sdk-preparation.ts";
import {
  bubblewrapArguments,
  type BubblewrapInvocation,
} from "./bubblewrap-launcher.ts";
import {
  SourceWorkspaceChangedError,
  ProposalWorkspaceChangedError,
  applyWorkspaceChanges,
  collectWorkspaceChanges,
  createWorkspaceManifest,
  type CollectedWorkspaceChangeSet,
  type WorkspaceManifest,
} from "./proposal-workspace.ts";
import {
  acceptedBubblewrapProposalPreflight,
  evaluateBubblewrapProposalIntent,
  findBubblewrapExecutable,
  verifyBubblewrapExecutable,
} from "./preflight-policy.ts";

export const PI_BUBBLEWRAP_PROPOSE_WRITE_BACKEND_ID =
  "pi-bwrap-propose-write";

export const PI_BUBBLEWRAP_PROPOSE_WRITE_BACKEND_DESCRIPTOR: BackendDescriptor =
  {
    id: PI_BUBBLEWRAP_PROPOSE_WRITE_BACKEND_ID,
    version: "0.1.0",
    capabilities: {
      access: {
        readOnlyMountIsolation: false,
        readWriteMountIsolation: true,
        symlinkSafeContainment: true,
        processIsolation: true,
        agentNetworkIsolation: false,
      },
      executionBoundaries: ["isolated"],
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

export type PiBubblewrapRunReport = ProcessRunReport;

const MAX_STDOUT_BYTES = 8 * 1024 * 1024;
const MAX_REPORT_STREAM_BYTES = 8 * 1024 * 1024;
const TERMINATE_GRACE_MS = 5_000;

interface ActiveBubblewrapRun {
  child: ChildProcess;
  runDirectory: string;
  proposal: ProposalRecord;
  termination?: Promise<void>;
  terminationReason?: string;
}

type ProposalStatus = "ready" | "running" | "conflicted";

interface ProposalRecord {
  id: string;
  workspaceHandle: string;
  sourceRoot: string;
  workspacePath: string;
  leaseDirectory: string;
  baseline: WorkspaceManifest;
  status: ProposalStatus;
  /** Single-writer lease held between `start` and terminal collection. */
  activePreparedRunId?: string;
  turns: number;
  changeSet?: CollectedWorkspaceChangeSet;
}

export interface PiBubblewrapProposalSnapshot {
  id: string;
  workspaceHandle: string;
  status: ProposalStatus;
  baseTreeFingerprint: Fingerprint;
  turns: number;
  changeSet?: WorkspaceChangeSet;
}

export type PiBubblewrapProposalApplyResult =
  | {
      status: "applied";
      proposal: WorkspaceProposalReference;
      changeSet: WorkspaceChangeSet;
    }
  | {
      status: "conflicted";
      proposal: WorkspaceProposalReference;
      reason: "source-changed" | "proposal-changed";
      message: string;
    }
  | {
      status: "unavailable" | "busy";
      proposal: WorkspaceProposalReference;
      message: string;
    }
  | {
      status: "failed";
      proposal: WorkspaceProposalReference;
      message: string;
      /** A non-conflict apply error can happen after source mutations begin. */
      sourceMayBePartiallyApplied: true;
    };

export interface PiBubblewrapBackendOptions {
  modelRegistry: PiModelRegistry;
  modelRuntime?: ModelRuntime;
  /** Logical workspace root used during exact Pi prompt preparation. */
  cwd: string;
  /** Private host-path mapping for the first backend's one workspace handle. */
  workspaceRoots: Readonly<Record<string, string>>;
  /** Optional absolute path to Bubblewrap; defaults to `bwrap` on PATH. */
  bwrapPath?: string;
  now?: () => Date;
  idFactory?: () => string;
  invocationFactory?: (piArgs: string[]) => BubblewrapInvocation;
  bridgePath?: string;
  /** Additional explicit host runtime paths to mount read-only in Bubblewrap. */
  runtimeReadOnlyPaths?: readonly string[];
  /**
   * Exact child environment, including provider authentication if needed.
   * The Bubblewrap child never inherits the parent process environment.
   */
  env?: Readonly<Record<string, string>>;
}

/**
 * Linux Bubblewrap backend for a single proposal workspace. The parent-side
 * SDK gate preserves exact preparation; execution runs Pi and bash in an
 * isolated child whose only writable project mount is a temporary copy of the
 * requested workspace. The following proposal slice retains this copy and
 * derives a reviewable change set instead of cleaning it at terminal settle.
 */
export class PiBubblewrapBackend implements ExecutionBackend {
  readonly descriptor: BackendDescriptor = structuredClone(
    PI_BUBBLEWRAP_PROPOSE_WRITE_BACKEND_DESCRIPTOR,
  );
  readonly #preparations: SdkPreparationGate;
  readonly #modelRegistry: PiModelRegistry;
  readonly #cwd: string;
  readonly #workspaceRoots: Readonly<Record<string, string>>;
  readonly #bwrapPath: string | undefined;
  readonly #now: () => Date;
  readonly #idFactory: () => string;
  readonly #invocationFactory: (piArgs: string[]) => BubblewrapInvocation;
  readonly #bridgePath: string;
  readonly #runtimeReadOnlyPaths: readonly string[];
  readonly #env?: Readonly<Record<string, string>>;
  readonly #active = new Map<string, ActiveBubblewrapRun>();
  readonly #reports = new Map<string, PiBubblewrapRunReport>();
  readonly #proposals = new Map<string, ProposalRecord>();
  readonly #proposalByPreparedRun = new Map<string, string>();

  constructor(options: PiBubblewrapBackendOptions) {
    this.#modelRegistry = options.modelRegistry;
    this.#preparations = new SdkPreparationGate({
      modelRegistry: options.modelRegistry,
      ...(options.modelRuntime ? { modelRuntime: options.modelRuntime } : {}),
      cwd: options.cwd,
      ...(options.now ? { now: options.now } : {}),
      tempDirPrefix: "pi-subagent-runtime-bwrap-prepare-",
    });
    this.#cwd = options.cwd;
    this.#workspaceRoots = { ...options.workspaceRoots };
    const bwrapPath = findBubblewrapExecutable(options.bwrapPath);
    this.#bwrapPath =
      bwrapPath && verifyBubblewrapExecutable(bwrapPath)
        ? bwrapPath
        : undefined;
    this.#now = options.now ?? (() => new Date());
    this.#idFactory =
      options.idFactory ?? (() => `pi-bwrap-preflight:${randomUUID()}`);
    this.#invocationFactory = options.invocationFactory ?? defaultPiInvocation;
    this.#bridgePath = options.bridgePath ?? defaultBridgePath();
    this.#runtimeReadOnlyPaths = [
      packageRootFromBridgePath(this.#bridgePath),
      nodeRuntimeRoot(process.execPath),
      ...(options.runtimeReadOnlyPaths ?? []),
    ];
    if (options.env) this.#env = options.env;
  }

  preflight(input: BackendPreflightInput): BackendPreflightResult {
    const requestedWorkspace = input.intent.access.workspaces[0];
    const proposal = this.#proposalForIntent(input.intent);
    const workspaceRoots = { ...this.#workspaceRoots };
    const proposalDiagnostics = [] as ReturnType<
      typeof evaluateBubblewrapProposalIntent
    >["diagnostics"];
    if (input.intent.workspaceProposal) {
      if (!proposal || proposal.status !== "ready") {
        proposalDiagnostics.push({
          level: "error",
          code: "pi-bwrap.proposal",
          message: `Unknown or unavailable Bubblewrap proposal: ${input.intent.workspaceProposal.id}.`,
          path: "workspaceProposal.id",
        });
      } else if (requestedWorkspace) {
        workspaceRoots[requestedWorkspace.handle] = proposal.workspacePath;
      }
    }
    const { diagnostics, model } = evaluateBubblewrapProposalIntent(
      input.intent,
      this.#modelRegistry,
      {
        cwd: this.#cwd,
        workspaceRoots,
        ...(this.#bwrapPath ? { bwrapPath: this.#bwrapPath } : {}),
      },
      "pi-bwrap",
    );
    diagnostics.push(...proposalDiagnostics);
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
    return acceptedBubblewrapProposalPreflight({
      descriptor: this.descriptor,
      preflightId,
      intent: input.intent,
      model,
      diagnostics,
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
        "Pi Bubblewrap execution plan does not match its prepared prompt.",
      );
    }
    await this.#preparations.stop(primed);

    const workspace = plan.intent.access.workspaces[0]!;
    let proposal = this.#proposalForIntent(plan.intent);
    let createdProposal = false;
    if (plan.intent.workspaceProposal && !proposal) {
      throw new Error(
        `Bubblewrap proposal ${plan.intent.workspaceProposal.id} is no longer available for revision.`,
      );
    }
    if (!proposal) {
      const sourceWorkspace = this.#workspaceRoots[workspace.handle];
      if (!sourceWorkspace) {
        throw new Error(
          `Pi Bubblewrap execution has no configured path for workspace ${workspace.handle}.`,
        );
      }
      proposal = this.#createProposal(sourceWorkspace, workspace.handle);
      createdProposal = true;
    }
    if (proposal.status !== "ready" || proposal.activePreparedRunId) {
      if (createdProposal) this.#removeProposal(proposal);
      throw new Error(`Bubblewrap proposal ${proposal.id} is not ready for a run.`);
    }
    if (!this.#bwrapPath) {
      if (createdProposal) this.#removeProposal(proposal);
      throw new Error("Pi Bubblewrap executable disappeared after preflight.");
    }
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
      executionBoundary: "isolated",
    });
    this.#reports.set(plan.preparedRunId, report);
    context.emit({
      phase: "starting",
      message: `Starting Bubblewrap proposal run with ${effectiveToolNames.join(", ") || "no tools"}.`,
      details: processReportSummary(report),
    });

    const runDirectory = mkdtempSync(join(tmpdir(), "pi-subagent-runtime-bwrap-run-"));
    let child: ChildProcess;
    const previousChangeSet = proposal.changeSet;
    try {
      proposal.status = "running";
      proposal.activePreparedRunId = plan.preparedRunId;
      delete proposal.changeSet;
      this.#proposalByPreparedRun.set(plan.preparedRunId, proposal.id);
      const bridgeInput = createBridgeInput(plan, effectiveToolNames);
      const inputPath = join(runDirectory, "bridge-input.json");
      const systemPromptPath = join(runDirectory, "system-prompt.md");
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
      const childEnv = childEnvironment({
        ...(this.#env ?? {}),
        [SUBPROCESS_BRIDGE_INPUT_ENV]: inputPath,
        [SUBPROCESS_REPORT_FD_ENV]: "3",
      });
      const bwrapArgs = bubblewrapArguments({
        invocation,
        proposalPath: proposal.workspacePath,
        workspacePath: this.#cwd,
        runDirectory,
        runtimeReadOnlyPaths: this.#runtimeReadOnlyPaths,
        env: childEnv,
      });
      child = spawn(this.#bwrapPath, bwrapArgs, {
        cwd: this.#cwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe", "pipe"],
        env: {},
      });
    } catch (error) {
      rmSync(runDirectory, { recursive: true, force: true });
      if (createdProposal) this.#removeProposal(proposal);
      else {
        proposal.status = "ready";
        delete proposal.activePreparedRunId;
        if (previousChangeSet) proposal.changeSet = previousChangeSet;
      }
      report.status = context.signal.aborted ? "cancelled" : "failed";
      report.finishedAt = this.#now().toISOString();
      if (!context.signal.aborted) {
        report.errorMessage =
          error instanceof Error ? error.message : String(error);
      }
      throw error;
    }

    const terminal = this.#watchChild(
      child,
      plan,
      report,
      context,
      runDirectory,
      proposal,
    );
    return {
      result: terminal,
      cancel: async (reason) => {
        await this.#terminateRun(plan.preparedRunId, reason);
      },
      dispose: async () => {
        await this.#terminateRun(
          plan.preparedRunId,
          "Bubblewrap execution disposed.",
        );
        rmSync(runDirectory, { recursive: true, force: true });
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

  takeReport(preparedRunId: string): PiBubblewrapRunReport | undefined {
    const report = this.#reports.get(preparedRunId);
    if (!report) return undefined;
    this.#reports.delete(preparedRunId);
    return sanitizeProcessRunReport(report, sanitizeSubprocessReportValue);
  }

  /** Returns the retained proposal associated with a completed or active run. */
  getProposal(preparedRunId: string): PiBubblewrapProposalSnapshot | undefined {
    const proposalId = this.#proposalByPreparedRun.get(preparedRunId);
    const proposal = proposalId ? this.#proposals.get(proposalId) : undefined;
    return proposal ? proposalSnapshot(proposal) : undefined;
  }

  /** Removes a retained proposal after the host has rejected or applied it. */
  async discardProposal(proposalId: string): Promise<void> {
    const proposal = this.#proposals.get(proposalId);
    if (!proposal) return;
    const active = [...this.#active.entries()].find(
      ([, run]) => run.proposal === proposal,
    );
    if (active) {
      await this.#terminateRun(active[0], "Bubblewrap proposal discarded.");
    }
    this.#removeProposal(proposal);
  }

  /**
   * Performs a host-authorized, guarded check-then-apply of a retained
   * proposal. The exact reviewed change set must still match the retained
   * revision. A source/proposal conflict is detected before mutation and
   * leaves the original untouched. This operation is not transactionally
   * atomic for non-conflict I/O failures, so hosts must serialize writers and
   * treat `failed` as potentially partially applied.
   */
  async applyProposal(
    reviewedChangeSet: WorkspaceChangeSet,
  ): Promise<PiBubblewrapProposalApplyResult> {
    const reference = reviewedChangeSet.proposal;
    const proposal = this.#proposalForReference(reference);
    const proposalReference = structuredClone(reference);
    if (!proposal) {
      return {
        status: "unavailable",
        proposal: proposalReference,
        message: "Bubblewrap proposal is unavailable or belongs to another workspace.",
      };
    }
    if (proposal.status === "running" || proposal.activePreparedRunId) {
      return {
        status: "busy",
        proposal: proposalReference,
        message: "Bubblewrap proposal is still running.",
      };
    }
    if (proposal.status === "conflicted") {
      return {
        status: "conflicted",
        proposal: proposalReference,
        reason: "source-changed",
        message: "Bubblewrap proposal is already conflicted and cannot be applied.",
      };
    }
    const changeSet = proposalChangeSet(proposal);
    if (!changeSet || !proposal.changeSet) {
      return {
        status: "unavailable",
        proposal: proposalReference,
        message: "Bubblewrap proposal has no completed change set to apply.",
      };
    }
    if (canonicalJson(changeSet) !== canonicalJson(reviewedChangeSet)) {
      return {
        status: "conflicted",
        proposal: proposalReference,
        reason: "proposal-changed",
        message:
          "The reviewed change set does not match the proposal's current revision.",
      };
    }
    try {
      applyWorkspaceChanges({
        sourceRoot: proposal.sourceRoot,
        proposalRoot: proposal.workspacePath,
        baseline: proposal.baseline,
        changeSet: proposal.changeSet,
      });
    } catch (error) {
      if (error instanceof SourceWorkspaceChangedError) {
        proposal.status = "conflicted";
        return {
          status: "conflicted",
          proposal: proposalReference,
          reason: "source-changed",
          message: error.message,
        };
      }
      if (error instanceof ProposalWorkspaceChangedError) {
        proposal.status = "conflicted";
        return {
          status: "conflicted",
          proposal: proposalReference,
          reason: "proposal-changed",
          message: error.message,
        };
      }
      return {
        status: "failed",
        proposal: proposalReference,
        sourceMayBePartiallyApplied: true,
        message: `Bubblewrap proposal apply failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
    this.#removeProposal(proposal);
    return { status: "applied", proposal: proposalReference, changeSet };
  }

  async dispose(): Promise<void> {
    await this.#preparations.stopAll();
    await Promise.all(
      [...this.#active.keys()].map((preparedRunId) =>
        this.#terminateRun(preparedRunId, "Bubblewrap backend disposed."),
      ),
    );
    this.#active.clear();
    for (const proposal of this.#proposals.values()) {
      this.#removeProposal(proposal);
    }
    this.#reports.clear();
    this.#proposalByPreparedRun.clear();
  }

  #proposalForIntent(
    intent: BoundExecutionInput["plan"]["intent"],
  ): ProposalRecord | undefined {
    return this.#proposalForReference(intent.workspaceProposal);
  }

  #proposalForReference(
    reference: WorkspaceProposalReference | undefined,
  ): ProposalRecord | undefined {
    if (!reference) return undefined;
    const proposal = this.#proposals.get(reference.id);
    if (!proposal || proposal.workspaceHandle !== reference.workspaceHandle) {
      return undefined;
    }
    return proposal;
  }

  #createProposal(sourceRoot: string, workspaceHandle: string): ProposalRecord {
    const leaseDirectory = mkdtempSync(
      join(tmpdir(), "pi-subagent-runtime-bwrap-proposal-"),
    );
    const workspacePath = join(leaseDirectory, "workspace");
    try {
      const canonicalSourceRoot = realpathSync(sourceRoot);
      const baseline = createWorkspaceManifest(canonicalSourceRoot);
      cpSync(canonicalSourceRoot, workspacePath, {
        recursive: true,
        force: false,
        errorOnExist: true,
        preserveTimestamps: true,
        verbatimSymlinks: true,
      });
      const proposal: ProposalRecord = {
        id: `pi-bwrap-proposal:${randomUUID()}`,
        workspaceHandle,
        sourceRoot: canonicalSourceRoot,
        workspacePath,
        leaseDirectory,
        baseline,
        status: "ready",
        turns: 0,
      };
      this.#proposals.set(proposal.id, proposal);
      return proposal;
    } catch (error) {
      rmSync(leaseDirectory, { recursive: true, force: true });
      throw error;
    }
  }

  #removeProposal(proposal: ProposalRecord): void {
    this.#proposals.delete(proposal.id);
    for (const [preparedRunId, proposalId] of this.#proposalByPreparedRun) {
      if (proposalId === proposal.id) this.#proposalByPreparedRun.delete(preparedRunId);
    }
    rmSync(proposal.leaseDirectory, { recursive: true, force: true });
  }

  #collectProposalChanges(
    proposal: ProposalRecord,
    preparedRunId: string,
    report: PiBubblewrapRunReport,
  ): void {
    try {
      proposal.changeSet = collectWorkspaceChanges({
        sourceRoot: proposal.sourceRoot,
        proposalRoot: proposal.workspacePath,
        baseline: proposal.baseline,
      });
      proposal.turns += 1;
      proposal.status = "ready";
    } catch (error) {
      proposal.status = "conflicted";
      delete proposal.changeSet;
      report.errorMessage ??=
        error instanceof SourceWorkspaceChangedError
          ? error.message
          : `Bubblewrap proposal change collection failed: ${
              error instanceof Error ? error.message : String(error)
            }`;
    } finally {
      if (proposal.activePreparedRunId === preparedRunId) {
        delete proposal.activePreparedRunId;
      }
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
    active.termination ??= terminateChild(active.child);
    await active.termination;
  }

  #watchChild(
    child: ChildProcess,
    plan: SealedPlanSnapshot,
    report: PiBubblewrapRunReport,
    context: BackendExecutionContext,
    runDirectory: string,
    proposal: ProposalRecord,
  ): Promise<BackendResult> {
    let stdoutBytes = 0;
    let reportBytes = 0;
    const active: ActiveBubblewrapRun = { child, runDirectory, proposal };
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
        failStream("Bubblewrap bridge emitted malformed report JSON.");
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
      failStream("Bubblewrap text output channel was unavailable.");
    } else {
      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > MAX_STDOUT_BYTES) {
          failStream(`Bubblewrap text output exceeded ${MAX_STDOUT_BYTES} bytes.`);
        }
      });
    }
    const reportStream = child.stdio[3] as Readable | null;
    if (!reportStream) {
      failStream("Bubblewrap bridge report channel was unavailable.");
    } else {
      reportStream.on("data", (chunk: Buffer) => {
        reportBytes += chunk.length;
        if (reportBytes > MAX_REPORT_STREAM_BYTES) {
          failStream(
            `Sanitized Bubblewrap report stream exceeded ${MAX_REPORT_STREAM_BYTES} bytes.`,
          );
        }
      });
      createInterface({ input: reportStream, crlfDelay: Infinity }).on(
        "line",
        processLine,
      );
    }
    if (!child.stderr) {
      failStream("Bubblewrap error output channel was unavailable.");
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
        rmSync(runDirectory, { recursive: true, force: true });
        if (outcome.code !== null) report.exitCode = outcome.code;
        if (outcome.signal !== null) report.signal = outcome.signal;
        report.finishedAt = this.#now().toISOString();
        if (outcome.spawnError) report.errorMessage = outcome.spawnError.message;
        this.#collectProposalChanges(proposal, plan.preparedRunId, report);
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
    throw new Error("Pi Bubblewrap execution has no matching prepared plan.");
  }
  return primed;
}

function terminalResult(
  plan: SealedPlanSnapshot,
  report: PiBubblewrapRunReport,
  active: ActiveBubblewrapRun,
  context: BackendExecutionContext,
  outcome: { code: number | null; spawnError?: Error },
): BackendResult {
  const output = latestProcessAssistantText(report.messages);
  const enforcement: EnforcementReceipt = {
    access: structuredClone(plan.preflight.access),
    limits: structuredClone(plan.preflight.limits),
  };
  const usage = processRunUsage(report.usage);
  const workspaceChanges = proposalChangeSet(active.proposal);
  const changeSetResult = workspaceChanges
    ? { workspaceChanges: [workspaceChanges] }
    : {};
  if (context.signal.aborted || active.terminationReason) {
    report.status = "cancelled";
    context.emit({
      phase: "finishing",
      message: "Bubblewrap subagent cancelled.",
      details: processReportSummary(report),
    });
    return {
      status: "cancelled",
      reason: active.terminationReason ?? abortReason(context.signal),
      enforcement,
      ...changeSetResult,
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
      `Pi Bubblewrap child exited with code ${outcome.code ?? "unknown"}.`;
    context.emit({
      phase: "finishing",
      message: `Bubblewrap subagent failed: ${message}`,
      details: processReportSummary(report),
    });
    return {
      status: "failed",
      error: { code: "bubblewrap", message, retryable: false },
      enforcement,
      ...changeSetResult,
      ...(usage ? { usage } : {}),
      ...(output ? { output: { text: output, partial: true } } : {}),
    };
  }
  if (!output) {
    report.status = "failed";
    report.errorMessage = "Pi Bubblewrap child produced no assistant report.";
    context.emit({
      phase: "finishing",
      message: "Bubblewrap subagent failed: no assistant report.",
      details: processReportSummary(report),
    });
    return {
      status: "failed",
      error: {
        code: "bubblewrap-empty",
        message: report.errorMessage,
        retryable: false,
      },
      enforcement,
      ...changeSetResult,
      ...(usage ? { usage } : {}),
    };
  }
  report.status = "completed";
  context.emit({
    phase: "finishing",
    message: "Bubblewrap subagent report ready.",
    details: processReportSummary(report),
  });
  return {
    status: "completed",
    output: { text: output, partial: false },
    enforcement,
    ...changeSetResult,
    ...(usage ? { usage } : {}),
  };
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

function proposalSnapshot(proposal: ProposalRecord): PiBubblewrapProposalSnapshot {
  const changeSet = proposalChangeSet(proposal);
  return {
    id: proposal.id,
    workspaceHandle: proposal.workspaceHandle,
    status: proposal.status,
    baseTreeFingerprint: proposal.baseline.treeFingerprint,
    turns: proposal.turns,
    ...(changeSet
      ? { changeSet }
      : {}),
  };
}

function proposalChangeSet(
  proposal: ProposalRecord,
): WorkspaceChangeSet | undefined {
  if (!proposal.changeSet) return undefined;
  return {
    proposal: {
      id: proposal.id,
      workspaceHandle: proposal.workspaceHandle,
    },
    ...structuredClone(proposal.changeSet),
  };
}

function defaultPiInvocation(piArgs: string[]): BubblewrapInvocation {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtualScript && existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...piArgs] };
  }
  const execName = basename(process.execPath).toLowerCase();
  if (!/^(node|bun)(\.exe)?$/.test(execName)) {
    return { command: process.execPath, args: piArgs };
  }
  const piPath = findPathExecutable("pi");
  if (!piPath) {
    throw new Error("Pi CLI executable was not found on PATH.");
  }
  return { command: piPath, args: piArgs };
}

function defaultBridgePath(): string {
  const extension = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
  return join(
    dirname(fileURLToPath(import.meta.url)),
    `../shared/process-bridge${extension}`,
  );
}

function subprocessArguments(
  plan: SealedPlanSnapshot,
  toolNames: readonly string[],
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

function childEnvironment(
  extra: Readonly<Record<string, string>>,
): Record<string, string> {
  return { ...extra };
}

function packageRootFromBridgePath(bridgePath: string): string {
  return dirname(dirname(dirname(dirname(bridgePath))));
}

function nodeRuntimeRoot(nodePath: string): string {
  return dirname(dirname(nodePath));
}

function findPathExecutable(name: string): string | undefined {
  const path = process.env.PATH;
  if (!path) return undefined;
  for (const directory of path.split(":")) {
    if (!directory) continue;
    const candidate = join(directory, name);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
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
    : "Bubblewrap execution cancelled.";
}
