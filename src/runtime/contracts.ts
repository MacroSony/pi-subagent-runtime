import type {
  BackendDescriptor,
  BackendPreflightAccepted,
  BackendPreflightResult,
  EnforcementReceipt,
  ExecutionIntent,
  Fingerprint,
  LimitName,
  PreparedConversation,
  PromptRuntime,
  RunError,
  RunEvent,
  RunOutput,
  RunResult,
  RunSnapshot,
  RunUsage,
  SealedPlanSnapshot,
} from "../core/index.ts";

export interface Disposable {
  dispose(): void;
}

export interface PrepareRequest {
  backendId: string;
  intent: ExecutionIntent;
  compile(runtime: PromptRuntime): Promise<PreparedConversation>;
}

export interface PreparedRun {
  readonly id: string;
  readonly backendId: string;
  readonly conversationFingerprint: Fingerprint;
  readonly executionFingerprint: Fingerprint;
  snapshot(): SealedPlanSnapshot;
  discard(): Promise<void>;
}

export type RunEventListener = (event: RunEvent) => void;

export interface RunHandle {
  readonly id: string;
  snapshot(): RunSnapshot;
  subscribe(listener: RunEventListener): Disposable;
  cancel(reason?: string): Promise<void>;
  readonly result: Promise<RunResult>;
}

export interface ExecutionRuntime {
  prepare(request: PrepareRequest): Promise<PreparedRun>;
  execute(prepared: PreparedRun): RunHandle;
  registerBackend(backend: ExecutionBackend): Disposable;
  listBackends(): BackendDescriptor[];
  dispose(): Promise<void>;
}

export interface BackendPreflightInput {
  intent: ExecutionIntent;
  signal: AbortSignal;
}

export interface AcceptedPreparationInput {
  intent: ExecutionIntent;
  preflight: BackendPreflightAccepted;
}

export interface BackendPreparationContext {
  compile(runtime: PromptRuntime): Promise<PreparedConversation>;
  signal: AbortSignal;
}

export interface BackendPreparation {
  runtime: PromptRuntime;
  conversation: PreparedConversation;
  state?: unknown;
}

export interface BoundExecutionInput {
  plan: SealedPlanSnapshot;
  preparation: BackendPreparation;
}

export interface BackendRunEvent {
  phase: "starting" | "message" | "tool-result" | "finishing";
  message: string;
  details?: unknown;
}

export interface BackendExecutionContext {
  emit(event: BackendRunEvent): void;
  signal: AbortSignal;
}

interface BackendResultCommon {
  enforcement: EnforcementReceipt;
  usage?: RunUsage;
}

export interface BackendResultCompleted extends BackendResultCommon {
  status: "completed";
  output: RunOutput;
}

export interface BackendResultFailed extends BackendResultCommon {
  status: "failed";
  error: RunError;
  output?: RunOutput;
}

export interface BackendResultCancelled extends BackendResultCommon {
  status: "cancelled";
  reason: string;
  output?: RunOutput;
}

export interface BackendResultTimedOut extends BackendResultCommon {
  status: "timed-out";
  reason: string;
  enforcedTimeoutMs: number;
  output?: RunOutput;
}

export interface BackendResultLimitReached extends BackendResultCommon {
  status: "limit-reached";
  reachedLimit: Exclude<LimitName, "timeoutMs">;
  output?: RunOutput;
}

export type BackendResult =
  | BackendResultCompleted
  | BackendResultFailed
  | BackendResultCancelled
  | BackendResultTimedOut
  | BackendResultLimitReached;

export interface BackendExecution {
  readonly result: Promise<BackendResult>;
  /**
   * Initiates cancellation and settles after the adapter's bounded escalation
   * has completed. It must not wait on `result` in a way that deadlocks the
   * caller.
   */
  cancel(reason?: string): Promise<void>;
  /**
   * Releases all execution resources. It must be idempotent and settle after
   * bounded adapter-specific cleanup; the runtime cannot recover resources
   * from a backend that never settles this hook.
   */
  dispose(): Promise<void>;
}

export interface ExecutionBackend {
  readonly descriptor: BackendDescriptor;
  preflight(
    input: BackendPreflightInput,
  ): Promise<BackendPreflightResult> | BackendPreflightResult;
  /**
   * Must invoke `context.compile()` exactly once and return its runtime and
   * conversation unchanged. If setup or compilation fails before this method
   * returns, the backend must release all partial resources before rejecting.
   */
  prepare(
    input: AcceptedPreparationInput,
    context: BackendPreparationContext,
  ): Promise<BackendPreparation> | BackendPreparation;
  /**
   * Starts transport and returns execution controls without waiting for the
   * terminal result. The adapter must honor `context.signal` and ensure its
   * own abort/kill escalation bounds the settlement of `result`.
   */
  start(
    input: BoundExecutionInput,
    context: BackendExecutionContext,
  ): Promise<BackendExecution> | BackendExecution;
  /**
   * Releases an unused preparation. It must be idempotent and settle after
   * bounded adapter-specific cleanup.
   */
  discard(preparation: BackendPreparation): Promise<void> | void;
}

export interface ExecutionRuntimeOptions {
  idFactory?: (kind: "prepared" | "run") => string;
  now?: () => number;
}
