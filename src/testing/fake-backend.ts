import {
  promptRuntimeFingerprint,
  type AccessCapabilities,
  type BackendDescriptor,
  type BackendPreflightResult,
  type ExecutionIntent,
  type LimitEnforcement,
  type LimitName,
  type PreparedConversation,
  type PromptRuntime,
  type SealedPlanSnapshot,
} from "../core/index.ts";
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
} from "../runtime/index.ts";

const ACCESS_CAPABILITIES: AccessCapabilities = {
  readOnlyMountIsolation: true,
  readWriteMountIsolation: true,
  symlinkSafeContainment: true,
  processIsolation: true,
  agentNetworkIsolation: true,
};

const TOOL_CATALOG = [
  { id: "tool.echo", name: "echo", effects: [] },
  {
    id: "tool.read",
    name: "read",
    effects: ["filesystem-read"] as const,
  },
  {
    id: "tool.write",
    name: "write",
    effects: ["filesystem-write"] as const,
  },
  { id: "tool.shell", name: "shell", effects: ["process"] as const },
  { id: "tool.web", name: "web", effects: ["network"] as const },
];

export type FakePreflightMode =
  | "accepted"
  | "rejected"
  | "throw"
  | "mismatched-descriptor";

export type FakePreparationMode =
  | "normal"
  | "bypass"
  | "mismatch"
  | "throw-before-compile"
  | "throw-after-compile"
  | "invalid";

export type FakeExecutionMode =
  | "completed"
  | "failed"
  | "backend-cancelled"
  | "timed-out"
  | "limit-reached"
  | "delayed"
  | "throw-start"
  | "throw-result"
  | "invalid"
  | "degraded-receipt"
  | "cleanup-throw"
  | "cancel-throw";

export interface DeterministicFakeBackendOptions {
  id?: string;
  fidelity?: BackendDescriptor["capabilities"]["promptRuntimeFidelity"];
  limitEnforcement?: Partial<
    Record<LimitName, Exclude<LimitEnforcement, "unsupported">>
  >;
  cancelSettles?: boolean;
}

interface PendingExecution {
  plan: SealedPlanSnapshot;
  resolve(result: BackendResult): void;
}

export class DeterministicFakeBackend implements ExecutionBackend {
  readonly descriptor: BackendDescriptor;
  preflightMode: FakePreflightMode = "accepted";
  preparationMode: FakePreparationMode = "normal";
  executionMode: FakeExecutionMode = "completed";
  readonly preflightCalls: ExecutionIntent[] = [];
  readonly preparationCalls: AcceptedPreparationInput[] = [];
  readonly startCalls: SealedPlanSnapshot[] = [];
  readonly discardCalls: BackendPreparation[] = [];
  readonly cancelCalls: string[] = [];
  readonly executionDisposeCalls: string[] = [];
  compilerCalls = 0;
  failureAtomicCleanupCalls = 0;
  cancelThrows = false;
  readonly #limitEnforcement: DeterministicFakeBackendOptions["limitEnforcement"];
  readonly #cancelSettles: boolean;
  #preflightCounter = 0;
  #preparationCounter = 0;
  #pendingExecutions: PendingExecution[] = [];
  #startWaiters: Array<() => void> = [];

  constructor(options: DeterministicFakeBackendOptions = {}) {
    const fidelity = options.fidelity ?? "backend-assisted";
    this.#limitEnforcement = options.limitEnforcement ?? {};
    this.#cancelSettles = options.cancelSettles ?? false;
    this.descriptor = {
      id: options.id ?? "fake-backend",
      version: "1.0.0",
      capabilities: {
        access: { ...ACCESS_CAPABILITIES },
        executionBoundaries: ["isolated", "shared-user"],
        limits: {
          timeoutMs: ["backend-hard", "host-abort"],
          maxTurns: ["backend-hard"],
          tokenBudget: ["backend-hard"],
          maxOutputBytes: ["backend-hard"],
        },
        cancellation: true,
        mediaMimeTypes: ["image/png"],
        remoteTransport: false,
        promptRuntimeFidelity: fidelity,
      },
    };
  }

  preflight(input: BackendPreflightInput): BackendPreflightResult {
    this.preflightCalls.push(structuredClone(input.intent));
    if (this.preflightMode === "throw") {
      throw new Error("Fake preflight failed.");
    }
    const preflightId = `preflight-${++this.#preflightCounter}`;
    if (this.preflightMode === "rejected") {
      return {
        status: "rejected",
        preflightId,
        backend: structuredClone(this.descriptor),
        diagnostics: [
          {
            level: "error",
            code: "fake.rejected",
            message: "Fake backend rejected the execution intent.",
          },
        ],
      };
    }

    const limits: Record<string, unknown> = {};
    for (const name of [
      "timeoutMs",
      "maxTurns",
      "tokenBudget",
      "maxOutputBytes",
    ] as const) {
      const requirement = input.intent.limits[name];
      if (!requirement) continue;
      limits[name] = {
        value: requirement.value,
        enforcement: this.#limitEnforcement?.[name] ?? "backend-hard",
      };
    }
    const mounts = input.intent.access.workspaces.map((workspace, index) => ({
      workspaceHandle: workspace.handle,
      mountId: `mount-${index + 1}`,
      mode: workspace.mode,
    }));
    const requestedWorkingDirectory = input.intent.access.workingDirectory;
    const workingMount = requestedWorkingDirectory
      ? mounts.find(
          (mount) =>
            mount.workspaceHandle ===
            requestedWorkingDirectory.workspaceHandle,
        )
      : undefined;
    const isolated =
      input.intent.access.executionBoundary === "isolated";
    const backend = structuredClone(this.descriptor);
    if (this.preflightMode === "mismatched-descriptor") {
      backend.version = "unexpected";
    }
    const result = {
      status: "accepted" as const,
      preflightId,
      backend,
      model: structuredClone(input.intent.model),
      ...(input.intent.thinkingLevel === undefined
        ? {}
        : { thinkingLevel: input.intent.thinkingLevel }),
      toolCatalog: structuredClone(TOOL_CATALOG),
      access: {
        level: input.intent.access.level,
        mounts,
        ...(requestedWorkingDirectory && workingMount
          ? {
              workingDirectory: {
                mountId: workingMount.mountId,
                path: requestedWorkingDirectory.path,
              },
            }
          : {}),
        network: input.intent.access.network,
        process: input.intent.access.allowProcess === true,
        executionBoundary: input.intent.access.executionBoundary,
        enforcement: isolated
          ? { ...ACCESS_CAPABILITIES }
          : {
              readOnlyMountIsolation: false,
              readWriteMountIsolation: false,
              symlinkSafeContainment: false,
              processIsolation: false,
              agentNetworkIsolation: false,
            },
      },
      limits,
      ...(this.descriptor.capabilities.promptRuntimeFidelity ===
      "exact-preflight"
        ? {
            promptRuntime: fakePromptRuntime(
              "exact-preflight",
              input.intent,
            ),
          }
        : {}),
      diagnostics: [],
    };
    return result as BackendPreflightResult;
  }

  async prepare(
    input: AcceptedPreparationInput,
    context: BackendPreparationContext,
  ): Promise<BackendPreparation> {
    this.preparationCalls.push(structuredClone(input));
    if (this.preparationMode === "throw-before-compile") {
      throw new Error("Fake preparation failed before compilation.");
    }
    const runtime =
      input.preflight.promptRuntime ??
      fakePromptRuntime("backend-assisted", input.intent);
    if (this.preparationMode === "bypass") {
      return {
        runtime,
        conversation: fakePreparedConversation("Backend-authored."),
        state: { id: `preparation-${++this.#preparationCounter}` },
      };
    }

    let conversation: PreparedConversation;
    try {
      this.compilerCalls += 1;
      conversation = await context.compile(runtime);
    } catch (error) {
      this.failureAtomicCleanupCalls += 1;
      throw error;
    }
    if (this.preparationMode === "throw-after-compile") {
      this.failureAtomicCleanupCalls += 1;
      throw new Error("Fake preparation failed after compilation.");
    }
    if (this.preparationMode === "invalid") {
      return { state: { id: "invalid-preparation" } } as BackendPreparation;
    }
    if (this.preparationMode === "mismatch") {
      return {
        runtime,
        conversation: {
          ...conversation,
          systemPrompt: "Backend-tampered.",
        },
        state: { id: `preparation-${++this.#preparationCounter}` },
      };
    }
    return {
      runtime,
      conversation,
      state: { id: `preparation-${++this.#preparationCounter}` },
    };
  }

  start(
    input: BoundExecutionInput,
    context: BackendExecutionContext,
  ): BackendExecution {
    this.startCalls.push(structuredClone(input.plan));
    this.#resolveStartWaiters();
    if (this.executionMode === "throw-start") {
      throw new Error("Fake backend failed during start.");
    }
    context.emit({
      phase: "message",
      message: "Fake backend started.",
      details: { preparedRunId: input.plan.preparedRunId },
    });

    let result: Promise<BackendResult>;
    if (this.executionMode === "delayed") {
      result = new Promise<BackendResult>((resolve) => {
        this.#pendingExecutions.push({
          plan: structuredClone(input.plan),
          resolve,
        });
      });
    } else if (this.executionMode === "throw-result") {
      result = Promise.reject(new Error("Fake provider transport failed."));
    } else {
      const resultMode =
        this.executionMode === "cleanup-throw" ||
        this.executionMode === "cancel-throw"
          ? "completed"
          : this.executionMode;
      result = Promise.resolve(
        fakeBackendResult(resultMode, input.plan),
      );
    }

    return {
      result,
      cancel: (reason = "cancelled") => {
        this.cancelCalls.push(reason);
        if (this.executionMode === "cancel-throw" || this.cancelThrows) {
          throw new Error("Fake cancellation failed.");
        }
        if (this.#cancelSettles) {
          this.releaseExecution(input.plan.preparedRunId);
        }
        return Promise.resolve();
      },
      dispose: async () => {
        this.executionDisposeCalls.push(input.plan.preparedRunId);
        if (this.executionMode === "cleanup-throw") {
          throw new Error("Fake execution cleanup failed.");
        }
      },
    };
  }

  discard(preparation: BackendPreparation): void {
    this.discardCalls.push(preparation);
  }

  waitForStart(): Promise<void> {
    if (this.startCalls.length > 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.#startWaiters.push(resolve);
    });
  }

  releaseNextExecution(): void {
    const pending = this.#pendingExecutions.shift();
    if (!pending) return;
    pending.resolve(fakeBackendResult("completed", pending.plan));
  }

  releaseExecution(preparedRunId: string): void {
    const index = this.#pendingExecutions.findIndex(
      ({ plan }) => plan.preparedRunId === preparedRunId,
    );
    if (index < 0) return;
    const [pending] = this.#pendingExecutions.splice(index, 1);
    pending!.resolve(fakeBackendResult("completed", pending!.plan));
  }

  #resolveStartWaiters(): void {
    for (const resolve of this.#startWaiters.splice(0)) resolve();
  }
}

export function fakeExecutionIntent(
  overrides: Partial<ExecutionIntent> = {},
): ExecutionIntent {
  return {
    model: { provider: "test", id: "model" },
    thinkingLevel: "high",
    requestedTools: ["read"],
    access: {
      level: "read-only",
      executionBoundary: "isolated",
      workspaces: [{ handle: "workspace", mode: "read-only" }],
      workingDirectory: { workspaceHandle: "workspace", path: "." },
      network: "allow",
    },
    limits: {},
    provenance: { fixture: "deterministic-fake" },
    ...overrides,
  };
}

export function fakePromptRuntime(
  fidelity: PromptRuntime["fidelity"] = "backend-assisted",
  intent = fakeExecutionIntent(),
): PromptRuntime {
  const runtime: Omit<PromptRuntime, "promptRuntimeFingerprint"> = {
    baseSystemPrompt: "Base fake system prompt.",
    options: {
      selectedTools: [...intent.requestedTools],
      toolSnippets: { read: "Read a file." },
      promptGuidelines: ["Use only selected tools."],
      cwd: ".",
      contextFiles: [],
      skills: [],
    },
    model: structuredClone(intent.model),
    preparedAt: "2026-07-26T12:00:00.000Z",
    fidelity,
  };
  return {
    ...runtime,
    promptRuntimeFingerprint: promptRuntimeFingerprint(runtime),
  };
}

export function fakePreparedConversation(
  systemPrompt = "Prepared fake system prompt.",
): PreparedConversation {
  return {
    systemPrompt,
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "Perform the prepared task." }],
      },
    ],
  };
}

function fakeBackendResult(
  mode: Exclude<
    FakeExecutionMode,
    | "delayed"
    | "throw-start"
    | "throw-result"
    | "cleanup-throw"
    | "cancel-throw"
  > | "completed",
  plan: SealedPlanSnapshot,
): BackendResult {
  const common = {
    enforcement: {
      access: structuredClone(plan.preflight.access),
      limits: structuredClone(plan.preflight.limits),
    },
  };
  switch (mode) {
    case "failed":
      return {
        ...common,
        status: "failed",
        error: {
          code: "fake.provider",
          message: "Fake provider failed.",
          retryable: true,
        },
      };
    case "backend-cancelled":
      return {
        ...common,
        status: "cancelled",
        reason: "backend cancelled",
      };
    case "timed-out":
      return {
        ...common,
        status: "timed-out",
        reason: "backend timeout",
        enforcedTimeoutMs: plan.preflight.limits.timeoutMs?.value ?? 1,
      };
    case "limit-reached":
      return {
        ...common,
        status: "limit-reached",
        reachedLimit: "maxTurns",
      };
    case "invalid":
      return {
        ...common,
        status: "completed",
        output: { text: "Invalid partial completion.", partial: true },
      };
    case "degraded-receipt": {
      const access = structuredClone(plan.preflight.access);
      access.network = access.network === "allow" ? "deny" : "allow";
      return {
        ...common,
        enforcement: {
          ...common.enforcement,
          access,
        },
        status: "completed",
        output: { text: "Receipt mismatch.", partial: false },
      };
    }
    case "completed":
    default:
      return {
        ...common,
        status: "completed",
        output: { text: "Fake complete.", partial: false },
      };
  }
}
