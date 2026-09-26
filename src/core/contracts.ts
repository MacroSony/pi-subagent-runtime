export const EXECUTION_CONTRACT_VERSION = 1 as const;

export const FINGERPRINT_PREFIX = "sha256:v1:" as const;

export type Fingerprint = `${typeof FINGERPRINT_PREFIX}${string}`;

export type DiagnosticLevel = "error" | "warning" | "info";

export interface Diagnostic {
  level: DiagnosticLevel;
  code: string;
  message: string;
  path?: string;
}

export interface ModelReference {
  provider: string;
  id: string;
}

export interface MediaReference {
  id: string;
  kind: "image";
  mimeType: string;
  digest: Fingerprint;
  resourceHandle: string;
}

export type AccessLevel = "none" | "read-only" | "workspace-write";

export type WorkspaceMode = "read-only" | "read-write";

export type NetworkPolicy = "deny" | "allow";

export type ExecutionBoundary = "isolated" | "shared-user";

export interface WorkspaceRequest {
  handle: string;
  mode: WorkspaceMode;
}

export interface WorkingDirectoryRequest {
  workspaceHandle: string;
  path: string;
}

export interface AccessRequest {
  level: AccessLevel;
  executionBoundary: ExecutionBoundary;
  workspaces: readonly WorkspaceRequest[];
  workingDirectory?: WorkingDirectoryRequest;
  network: NetworkPolicy;
  allowProcess?: boolean;
}

/**
 * Opaque reference to a backend-owned proposal workspace retained from an
 * earlier run. The host supplies it only to request a fresh revision turn or
 * a backend-specific guarded apply; the backend resolves it to a host path.
 */
export interface WorkspaceProposalReference {
  id: string;
  workspaceHandle: string;
}

/** Filesystem entry state used as evidence in a proposal change set. */
export interface WorkspaceEntryState {
  path: string;
  kind: "file" | "directory" | "symlink";
  mode: number;
  size?: number;
  digest?: Fingerprint;
  target?: string;
}

export type WorkspaceChangeKind =
  | "added"
  | "modified"
  | "deleted"
  | "type-changed"
  | "mode-changed"
  | "symlink-changed";

export type WorkspaceDiffStatus =
  | "available"
  | "binary"
  | "too-large"
  | "truncated"
  | "unavailable";

/** One path-level transition in an authoritative proposal workspace diff. */
export interface WorkspaceChange {
  path: string;
  kind: WorkspaceChangeKind;
  before?: WorkspaceEntryState;
  after?: WorkspaceEntryState;
  diffStatus: WorkspaceDiffStatus;
  diff?: string;
}

/**
 * Bounded, deterministic evidence for a backend-owned proposal workspace.
 * The proposal reference is opaque and backend-local; hosts pass it back only
 * to that backend for a revision, guarded apply, or discard.
 */
export interface WorkspaceChangeSet {
  proposal: WorkspaceProposalReference;
  baseTreeFingerprint: Fingerprint;
  proposalTreeFingerprint: Fingerprint;
  changes: readonly WorkspaceChange[];
  totalDiffBytes: number;
}

export interface AccessCapabilities {
  readOnlyMountIsolation: boolean;
  readWriteMountIsolation: boolean;
  symlinkSafeContainment: boolean;
  processIsolation: boolean;
  agentNetworkIsolation: boolean;
}

export interface MountMapping {
  workspaceHandle: string;
  mountId: string;
  mode: WorkspaceMode;
}

export interface AccessReceipt {
  level: AccessLevel;
  mounts: readonly MountMapping[];
  workingDirectory?: { mountId: string; path: string };
  network: NetworkPolicy;
  process: boolean;
  executionBoundary: ExecutionBoundary;
  enforcement: AccessCapabilities;
}

export const LIMIT_NAMES = [
  "timeoutMs",
  "maxTurns",
  "tokenBudget",
  "maxOutputBytes",
] as const;

export type LimitName = (typeof LIMIT_NAMES)[number];

export type LimitRequirementLevel = "required" | "best-effort";

export interface LimitRequirement {
  value: number;
  enforcement: LimitRequirementLevel;
}

export type LimitRequest = Partial<Record<LimitName, LimitRequirement>>;

export type LimitEnforcement =
  | "backend-hard"
  | "host-abort"
  | "best-effort"
  | "unsupported";

export interface EnforcedLimit {
  value: number;
  enforcement: Exclude<LimitEnforcement, "unsupported">;
}

export type LimitReceipt = Partial<Record<LimitName, EnforcedLimit>>;

export type ToolEffect =
  | "filesystem-read"
  | "filesystem-write"
  | "process"
  | "network";

export interface BackendTool {
  id: string;
  name: string;
  description?: string;
  promptSnippet?: string;
  effects: readonly ToolEffect[];
  adapterMapping?: string;
}

export type PromptRuntimeFidelity =
  | "exact-preflight"
  | "backend-assisted"
  | "partial";

export interface BackendCapabilities {
  access: AccessCapabilities;
  executionBoundaries: readonly ExecutionBoundary[];
  limits: Record<LimitName, readonly LimitEnforcement[]>;
  cancellation: boolean;
  mediaMimeTypes: readonly string[];
  remoteTransport: boolean;
  promptRuntimeFidelity: PromptRuntimeFidelity;
  /** True only when this backend can retain a real in-memory child session. */
  continuation?: boolean;
}

export interface BackendDescriptor {
  id: string;
  version: string;
  capabilities: BackendCapabilities;
}

export interface PromptRuntimeSkill {
  name: string;
  description: string;
  filePath: string;
  disableModelInvocation: boolean;
}

export interface PromptRuntimeOptions {
  customPrompt?: string;
  selectedTools: readonly string[];
  toolSnippets: Readonly<Record<string, string>>;
  promptGuidelines: readonly string[];
  appendSystemPrompt?: string;
  cwd: string;
  contextFiles: readonly { path: string; content: string }[];
  skills: readonly PromptRuntimeSkill[];
}

export interface PromptRuntime {
  baseSystemPrompt: string;
  options: PromptRuntimeOptions;
  model: ModelReference;
  preparedAt: string;
  promptRuntimeFingerprint: Fingerprint;
  fidelity: Exclude<PromptRuntimeFidelity, "partial">;
}

export type PreparedMessageRole = "user" | "assistant" | "custom";

export type PreparedContentPart =
  | { type: "text"; text: string }
  | {
      type: "media";
      mediaId: string;
      mimeType: string;
      digest: Fingerprint;
      backendResourceId?: string;
    };

export interface PreparedMessage {
  role: PreparedMessageRole;
  content: readonly PreparedContentPart[];
}

export interface PreparedConversation {
  systemPrompt: string;
  messages: readonly PreparedMessage[];
}

export interface ContinuationIntent {
  retain: true;
  id?: string;
}

export interface ExecutionIntent {
  model: ModelReference;
  thinkingLevel?: string;
  requestedTools: readonly string[];
  access: AccessRequest;
  limits: LimitRequest;
  media?: readonly MediaReference[];
  workspaceProposal?: WorkspaceProposalReference;
  provenance?: Readonly<Record<string, string>>;
  /** Retain this in-process child, or identify one retained by this runtime. */
  continuation?: ContinuationIntent;
}

export interface BackendPreflightAccepted {
  status: "accepted";
  preflightId: string;
  backend: BackendDescriptor;
  model: ModelReference;
  thinkingLevel?: string;
  toolCatalog: readonly BackendTool[];
  access: AccessReceipt;
  limits: LimitReceipt;
  promptRuntime?: PromptRuntime;
  diagnostics: readonly Diagnostic[];
}

export interface BackendPreflightRejected {
  status: "rejected";
  preflightId: string;
  backend: BackendDescriptor;
  diagnostics: readonly Diagnostic[];
}

export type BackendPreflightResult =
  | BackendPreflightAccepted
  | BackendPreflightRejected;

export interface EffectiveTool {
  requestedName: string;
  backendToolId: string;
  backendToolName: string;
}

export interface SealedPlanSnapshot {
  schemaVersion: typeof EXECUTION_CONTRACT_VERSION;
  preparedRunId: string;
  backendId: string;
  preflightId: string;
  intent: ExecutionIntent;
  preflight: BackendPreflightAccepted;
  promptRuntime: PromptRuntime;
  conversation: PreparedConversation;
  effectiveTools: readonly EffectiveTool[];
  conversationFingerprint: Fingerprint;
  executionFingerprint: Fingerprint;
}

export interface EnforcementReceipt {
  access: AccessReceipt;
  limits: LimitReceipt;
}

export interface RunUsage {
  tokens?: {
    /** Uncached input tokens, matching Pi's Usage.input meaning. */
    input: number;
    output: number;
    total: number;
    /** Exact subtotal for receipts with known cache fields. */
    cacheRead?: number;
    /** Exact subtotal for receipts with known cache fields. */
    cacheWrite?: number;
    tokenizer?: string;
  };
  /**
   * Provider requests represented by this usage. Older/custom producers may
   * omit this metadata; consumers must then treat request/cache coverage as
   * unknown rather than infer it from token zeros.
   */
  requests?: {
    total: number;
    /** Receipts with valid input/output and paired cacheRead/cacheWrite counts. */
    cacheKnown: number;
    /** Requests with complete native-compatible token and cost usage. */
    usageKnown?: number;
  };
  cost?: {
    /** Aggregate cost, retained for compatibility with legacy producers. */
    amount: number;
    currency: string;
    /** Exact component subtotals for usageKnown receipts; may be partial. */
    breakdown?: {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
    };
  };
}

export interface RunError {
  code: string;
  message: string;
  retryable?: boolean;
}

export interface RunOutput {
  text: string;
  partial: boolean;
}

export interface RunResultCommon {
  schemaVersion: typeof EXECUTION_CONTRACT_VERSION;
  runId: string;
  preparedRunId: string;
  backendId: string;
  conversationFingerprint: Fingerprint;
  executionFingerprint: Fingerprint;
  model: ModelReference;
  effectiveToolIds: readonly string[];
  enforcement: EnforcementReceipt;
  durationMs: number;
  usage?: RunUsage;
  /** Authoritative proposed workspace changes, if this backend supports them. */
  workspaceChanges?: readonly WorkspaceChangeSet[];
  /** Opaque, runtime-instance-local handle for a retained child session. */
  continuationId?: string;
}

export interface RunResultCompleted extends RunResultCommon {
  status: "completed";
  output: RunOutput;
}

export interface RunResultFailed extends RunResultCommon {
  status: "failed";
  error: RunError;
  output?: RunOutput;
}

export interface RunResultCancelled extends RunResultCommon {
  status: "cancelled";
  reason: string;
  output?: RunOutput;
}

export interface RunResultTimedOut extends RunResultCommon {
  status: "timed-out";
  reason: string;
  enforcedTimeoutMs: number;
  output?: RunOutput;
}

export interface RunResultLimitReached extends RunResultCommon {
  status: "limit-reached";
  reachedLimit: Exclude<LimitName, "timeoutMs">;
  output?: RunOutput;
}

export type RunResult =
  | RunResultCompleted
  | RunResultFailed
  | RunResultCancelled
  | RunResultTimedOut
  | RunResultLimitReached;

export type RunPhase = "starting" | "message" | "tool-result" | "finishing";

export interface RunEvent {
  runId: string;
  sequence: number;
  timestamp: string;
  phase: RunPhase;
  message: string;
  details?: unknown;
}

export type RunState =
  | "starting"
  | "running"
  | "cancelling"
  | "settled";

export interface RunSnapshot {
  id: string;
  preparedRunId: string;
  backendId: string;
  state: RunState;
  startedAt: string;
  settledAt?: string;
  cancellationReason?: string;
}
