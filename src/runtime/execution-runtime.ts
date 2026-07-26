import { randomUUID } from "node:crypto";
import {
  EXECUTION_CONTRACT_VERSION,
  canonicalJson,
  conversationFingerprint,
  executionFingerprint,
  hasErrors,
  validateBackendDescriptor,
  validateBackendPreflight,
  validateExecutionIntent,
  validatePreparedConversation,
  validatePromptRuntime,
  validateRunResult,
  validateSealedPlanSnapshot,
  type BackendDescriptor,
  type BackendPreflightAccepted,
  type BackendPreflightResult,
  type Diagnostic,
  type EffectiveTool,
  type Fingerprint,
  type PreparedConversation,
  type PromptRuntime,
  type RunEvent,
  type RunResult,
  type RunSnapshot,
  type SealedPlanSnapshot,
} from "../core/index.ts";
import type {
  BackendExecution,
  BackendPreparation,
  BackendResult,
  Disposable,
  ExecutionBackend,
  ExecutionRuntime,
  ExecutionRuntimeOptions,
  PrepareRequest,
  PreparedRun,
  RunEventListener,
  RunHandle,
} from "./contracts.ts";
import { ExecutionRuntimeError } from "./errors.ts";

const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

interface BackendEntry {
  backend: ExecutionBackend;
  descriptor: BackendDescriptor;
}

interface PreparationOperation {
  controller: AbortController;
  completion: Promise<void>;
  complete(): void;
}

type PreparedState = "prepared" | "executing" | "discarding" | "discarded";

interface PreparedRecord {
  entry: BackendEntry;
  preparation: BackendPreparation;
  plan: SealedPlanSnapshot;
  state: PreparedState;
  handle: PreparedRunHandle;
  cleanup?: Promise<void>;
}

interface Cancellation {
  kind: "cancelled" | "timed-out";
  reason: string;
}

interface RunRecord {
  id: string;
  prepared: PreparedRecord;
  state: RunSnapshot["state"];
  startedAtMs: number;
  settledAtMs?: number;
  controller: AbortController;
  listeners: Set<RunEventListener>;
  sequence: number;
  result: Promise<RunResult>;
  resolveResult(result: RunResult): void;
  cancellation?: Cancellation;
  backendSettled: boolean;
  execution?: BackendExecution;
  cancelPromise?: Promise<void>;
  timeout?: ReturnType<typeof setTimeout>;
  settled: boolean;
  handle: RuntimeRunHandle;
}

export function createExecutionRuntime(
  options: ExecutionRuntimeOptions = {},
): ExecutionRuntime {
  return new ExecutionRuntimeImpl(options);
}

class ExecutionRuntimeImpl implements ExecutionRuntime {
  readonly #backends = new Map<string, BackendEntry>();
  readonly #preparedHandles = new WeakMap<object, PreparedRecord>();
  readonly #preparedRecords = new Set<PreparedRecord>();
  readonly #runs = new Set<RunRecord>();
  readonly #preparing = new Set<PreparationOperation>();
  readonly #acceptedPreflightKeys = new Set<string>();
  readonly #issuedIds = new Set<string>();
  readonly #idFactory: (kind: "prepared" | "run") => string;
  readonly #now: () => number;
  #disposed = false;
  #disposePromise?: Promise<void>;

  constructor(options: ExecutionRuntimeOptions) {
    this.#idFactory =
      options.idFactory ?? ((kind) => `${kind}:${randomUUID()}`);
    this.#now = options.now ?? Date.now;
  }

  registerBackend(backend: ExecutionBackend): Disposable {
    this.#assertOpen();
    validateBackendImplementation(backend);
    const descriptor = cloneCanonical(
      backend.descriptor,
      "backend.descriptor-canonical",
      "Backend descriptor must contain only canonical data.",
    );
    const diagnostics = validateBackendDescriptor(descriptor);
    if (hasErrors(diagnostics)) {
      throw runtimeError(
        "backend.invalid",
        "Backend descriptor is invalid.",
        diagnostics,
      );
    }
    if (this.#backends.has(descriptor.id)) {
      throw runtimeError(
        "backend.duplicate",
        `A backend is already registered as ${descriptor.id}.`,
      );
    }

    const entry: BackendEntry = {
      backend,
      descriptor: deepFreeze(descriptor),
    };
    this.#backends.set(descriptor.id, entry);
    let active = true;
    return {
      dispose: () => {
        if (!active) return;
        active = false;
        if (this.#backends.get(descriptor.id) === entry) {
          this.#backends.delete(descriptor.id);
        }
      },
    };
  }

  listBackends(): BackendDescriptor[] {
    return [...this.#backends.values()]
      .map(({ descriptor }) => structuredClone(descriptor))
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  async prepare(request: PrepareRequest): Promise<PreparedRun> {
    this.#assertOpen();
    if (!request || typeof request !== "object") {
      throw runtimeError(
        "preparation.request",
        "Prepare request must be an object.",
      );
    }
    if (typeof request.backendId !== "string" || !request.backendId) {
      throw runtimeError(
        "preparation.backend-id",
        "Prepare request must name a backendId.",
      );
    }
    if (typeof request.compile !== "function") {
      throw runtimeError(
        "preparation.compiler",
        "Prepare request must provide a compiler callback.",
      );
    }

    const entry = this.#backends.get(request.backendId);
    if (!entry) {
      throw runtimeError(
        "backend.missing",
        `Backend ${request.backendId} is not registered.`,
      );
    }
    const intent = cloneCanonical(
      request.intent,
      "intent.canonical",
      "Execution intent must contain only canonical data.",
    );
    const intentDiagnostics = validateExecutionIntent(intent);
    if (hasErrors(intentDiagnostics)) {
      throw runtimeError(
        "intent.invalid",
        "Execution intent is invalid.",
        intentDiagnostics,
      );
    }

    const operation = createPreparationOperation();
    this.#preparing.add(operation);
    let returnedPreparation: BackendPreparation | undefined;
    try {
      let preflightValue: unknown;
      try {
        preflightValue = await entry.backend.preflight({
          intent: structuredClone(intent),
          signal: operation.controller.signal,
        });
      } catch (cause) {
        throw runtimeError(
          operation.controller.signal.aborted
            ? "preflight.cancelled"
            : "preflight.backend-error",
          operation.controller.signal.aborted
            ? "Preflight was cancelled."
            : `Backend preflight failed: ${errorMessage(cause)}`,
          [],
          cause,
        );
      }
      const preflight = cloneCanonical(
        preflightValue,
        "preflight.canonical",
        "Backend preflight must contain only canonical data.",
      ) as BackendPreflightResult;
      const preflightDiagnostics = validateBackendPreflight(
        preflight,
        intent,
        entry.descriptor,
      );
      if (hasErrors(preflightDiagnostics)) {
        throw runtimeError(
          "preflight.invalid",
          "Backend returned an invalid preflight.",
          preflightDiagnostics,
        );
      }
      if (preflight.status === "rejected") {
        throw runtimeError(
          "preflight.rejected",
          `Backend ${entry.descriptor.id} rejected the execution intent.`,
          preflight.diagnostics,
        );
      }
      const preflightKey = `${entry.descriptor.id}\0${preflight.preflightId}`;
      if (this.#acceptedPreflightKeys.has(preflightKey)) {
        throw runtimeError(
          "preflight.duplicate-id",
          `Backend reused accepted preflight id ${preflight.preflightId}.`,
        );
      }
      this.#acceptedPreflightKeys.add(preflightKey);

      let compiledRuntime: PromptRuntime | undefined;
      let compiledConversation: PreparedConversation | undefined;
      let compilerInvoked = false;
      const compile = async (
        candidateRuntime: PromptRuntime,
      ): Promise<PreparedConversation> => {
        if (compilerInvoked) {
          throw runtimeError(
            "preparation.compiler-duplicate",
            "Backend invoked the host compiler more than once.",
          );
        }
        compilerInvoked = true;
        const runtime = cloneCanonical(
          candidateRuntime,
          "preparation.runtime-canonical",
          "Prompt runtime must contain only canonical data.",
        );
        const expectedFidelity =
          entry.descriptor.capabilities.promptRuntimeFidelity;
        if (expectedFidelity === "partial") {
          throw runtimeError(
            "preparation.partial",
            "A partial prompt runtime cannot prepare an exact run.",
          );
        }
        const runtimeDiagnostics = validatePromptRuntime(
          runtime,
          expectedFidelity,
        );
        if (
          runtime.model.provider !== preflight.model.provider ||
          runtime.model.id !== preflight.model.id
        ) {
          runtimeDiagnostics.push({
            level: "error",
            code: "preparation.runtime-model",
            message:
              "Prompt runtime model does not match the accepted preflight model.",
            path: "model",
          });
        }
        if (
          expectedFidelity === "exact-preflight" &&
          (!preflight.promptRuntime ||
            canonicalJson(runtime) !== canonicalJson(preflight.promptRuntime))
        ) {
          runtimeDiagnostics.push({
            level: "error",
            code: "preparation.runtime-binding",
            message:
              "Backend changed the exact prompt runtime accepted during preflight.",
            path: "$",
          });
        }
        if (hasErrors(runtimeDiagnostics)) {
          throw runtimeError(
            "preparation.runtime-invalid",
            "Backend supplied an invalid prompt runtime.",
            runtimeDiagnostics,
          );
        }

        let compilerOutput: unknown;
        try {
          compilerOutput = await request.compile(structuredClone(runtime));
        } catch (cause) {
          throw runtimeError(
            "preparation.compiler-error",
            `Host compiler failed: ${errorMessage(cause)}`,
            [],
            cause,
          );
        }
        const conversation = cloneCanonical(
          compilerOutput,
          "preparation.conversation-canonical",
          "Prepared conversation must contain only canonical data.",
        ) as PreparedConversation;
        const conversationDiagnostics =
          validatePreparedConversation(conversation);
        if (hasErrors(conversationDiagnostics)) {
          throw runtimeError(
            "preparation.conversation-invalid",
            "Host compiler returned an invalid prepared conversation.",
            conversationDiagnostics,
          );
        }
        compiledRuntime = structuredClone(runtime);
        compiledConversation = structuredClone(conversation);
        return structuredClone(conversation);
      };

      try {
        returnedPreparation = await entry.backend.prepare(
          {
            intent: structuredClone(intent),
            preflight: structuredClone(preflight),
          },
          {
            compile,
            signal: operation.controller.signal,
          },
        );
      } catch (cause) {
        if (cause instanceof ExecutionRuntimeError) throw cause;
        throw runtimeError(
          operation.controller.signal.aborted
            ? "preparation.cancelled"
            : "preparation.backend-error",
          operation.controller.signal.aborted
            ? "Backend preparation was cancelled."
            : `Backend preparation failed: ${errorMessage(cause)}`,
          [],
          cause,
        );
      }

      if (!compilerInvoked || !compiledRuntime || !compiledConversation) {
        const failedPreparation = returnedPreparation;
        returnedPreparation = undefined;
        await discardAfterFailure(entry, failedPreparation);
        throw runtimeError(
          "preparation.compiler-bypass",
          "Backend returned without invoking the host compiler.",
        );
      }
      if (!isBackendPreparation(returnedPreparation)) {
        const failedPreparation = returnedPreparation;
        returnedPreparation = undefined;
        await discardAfterFailure(entry, failedPreparation);
        throw runtimeError(
          "preparation.invalid",
          "Backend returned an invalid preparation object.",
        );
      }
      if (
        !canonicalValuesEqual(returnedPreparation.runtime, compiledRuntime) ||
        !canonicalValuesEqual(
          returnedPreparation.conversation,
          compiledConversation,
        )
      ) {
        const failedPreparation = returnedPreparation;
        returnedPreparation = undefined;
        await discardAfterFailure(entry, failedPreparation);
        throw runtimeError(
          "preparation.compiler-mismatch",
          "Backend altered the host compiler result.",
        );
      }
      if (operation.controller.signal.aborted || this.#disposed) {
        const failedPreparation = returnedPreparation;
        returnedPreparation = undefined;
        await discardAfterFailure(entry, failedPreparation);
        throw runtimeError(
          "preparation.cancelled",
          "Preparation was cancelled before sealing.",
        );
      }

      const preparedRunId = this.#newId("prepared");
      const effectiveTools = bindEffectiveTools(preflight, intent.requestedTools);
      const boundPreparation = bindPreparation(
        returnedPreparation,
        compiledRuntime,
        compiledConversation,
      );
      const planWithoutExecutionFingerprint: Omit<
        SealedPlanSnapshot,
        "executionFingerprint"
      > = {
        schemaVersion: EXECUTION_CONTRACT_VERSION,
        preparedRunId,
        backendId: entry.descriptor.id,
        preflightId: preflight.preflightId,
        intent: structuredClone(intent),
        preflight: structuredClone(preflight),
        promptRuntime: structuredClone(compiledRuntime),
        conversation: structuredClone(compiledConversation),
        effectiveTools,
        conversationFingerprint: conversationFingerprint(
          compiledConversation,
        ),
      };
      const plan: SealedPlanSnapshot = {
        ...planWithoutExecutionFingerprint,
        executionFingerprint: executionFingerprint(
          planWithoutExecutionFingerprint,
        ),
      };
      const planDiagnostics = validateSealedPlanSnapshot(plan);
      if (hasErrors(planDiagnostics)) {
        throw runtimeError(
          "preparation.seal-invalid",
          "Runtime generated an invalid sealed plan.",
          planDiagnostics,
        );
      }

      const frozenPlan = deepFreeze(structuredClone(plan));
      let handle!: PreparedRunHandle;
      handle = new PreparedRunHandle(
        frozenPlan,
        () => this.#discardHandle(handle),
      );
      const record: PreparedRecord = {
        entry,
        preparation: boundPreparation,
        plan: frozenPlan,
        state: "prepared",
        handle,
      };
      this.#preparedHandles.set(handle, record);
      this.#preparedRecords.add(record);
      returnedPreparation = undefined;
      return handle;
    } catch (cause) {
      if (returnedPreparation) {
        try {
          await discardAfterFailure(entry, returnedPreparation);
        } catch (cleanupCause) {
          throw runtimeError(
            "preparation.cleanup-error",
            `Backend cleanup failed after preparation error: ${errorMessage(cleanupCause)}`,
            [],
            new AggregateError([cause, cleanupCause]),
          );
        } finally {
          returnedPreparation = undefined;
        }
      }
      throw cause;
    } finally {
      this.#preparing.delete(operation);
      operation.complete();
    }
  }

  execute(prepared: PreparedRun): RunHandle {
    this.#assertOpen();
    const record =
      prepared && typeof prepared === "object"
        ? this.#preparedHandles.get(prepared)
        : undefined;
    if (!record || record.handle !== prepared) {
      throw runtimeError(
        "execution.unbound-handle",
        "Prepared handle was not created by this runtime.",
      );
    }
    if (record.state !== "prepared") {
      throw runtimeError(
        "execution.handle-consumed",
        `Prepared handle cannot execute from state ${record.state}.`,
      );
    }
    const diagnostics = validateSealedPlanSnapshot(record.plan);
    if (hasErrors(diagnostics)) {
      throw runtimeError(
        "execution.plan-invalid",
        "Prepared plan failed validation before execution.",
        diagnostics,
      );
    }
    if (
      !canonicalValuesEqual(
        record.preparation.runtime,
        record.plan.promptRuntime,
      ) ||
      !canonicalValuesEqual(
        record.preparation.conversation,
        record.plan.conversation,
      )
    ) {
      throw runtimeError(
        "execution.preparation-mismatch",
        "Backend preparation no longer matches the sealed plan.",
      );
    }

    const runId = this.#newId("run");
    const controller = new AbortController();
    let resolveResult!: (result: RunResult) => void;
    const result = new Promise<RunResult>((resolve) => {
      resolveResult = resolve;
    });
    let run!: RunRecord;
    const handle = new RuntimeRunHandle(
      runId,
      () => this.#runSnapshot(run),
      (listener) => this.#subscribe(run, listener),
      (reason) => this.#cancelRun(run, "cancelled", reason),
      result,
    );
    run = {
      id: runId,
      prepared: record,
      state: "starting",
      startedAtMs: this.#now(),
      controller,
      listeners: new Set(),
      sequence: 0,
      result,
      resolveResult,
      backendSettled: false,
      settled: false,
      handle,
    };
    try {
      record.state = "executing";
      this.#runs.add(run);
      const timeout = record.plan.preflight.limits.timeoutMs;
      if (timeout?.enforcement === "host-abort") {
        run.timeout = setTimeout(() => {
          void this.#cancelRun(run, "timed-out", "host timeout");
        }, timeout.value);
      }
    } catch (cause) {
      record.state = "prepared";
      this.#runs.delete(run);
      this.#clearTimeout(run);
      throw cause;
    }

    queueMicrotask(() => {
      void this.#dispatch(run);
    });
    return handle;
  }

  dispose(): Promise<void> {
    if (this.#disposePromise) return this.#disposePromise;
    this.#disposed = true;
    this.#backends.clear();
    this.#disposePromise = (async () => {
      for (const operation of this.#preparing) {
        operation.controller.abort("runtime disposed");
      }
      const preparationCompletions = [...this.#preparing].map(
        ({ completion }) => completion,
      );
      const discards = [...this.#preparedRecords].flatMap((record) => {
        if (record.state === "prepared") {
          return [this.#discardRecord(record)];
        }
        if (record.state === "discarding" && record.cleanup) {
          return [record.cleanup];
        }
        return [];
      });
      const cancellations = [...this.#runs].map((run) =>
        this.#cancelRun(run, "cancelled", "runtime disposed"),
      );
      const outcomes = await Promise.allSettled([
        ...preparationCompletions,
        ...discards,
        ...cancellations,
      ]);
      const failures = outcomes
        .filter(
          (outcome): outcome is PromiseRejectedResult =>
            outcome.status === "rejected",
        )
        .map(({ reason }) => reason);
      if (failures.length > 0) {
        throw new AggregateError(
          failures,
          "Runtime disposal encountered cleanup failures.",
        );
      }
    })();
    return this.#disposePromise;
  }

  async #discardHandle(handle: PreparedRunHandle): Promise<void> {
    const record = this.#preparedHandles.get(handle);
    if (!record) return;
    await this.#discardRecord(record);
  }

  async #discardRecord(record: PreparedRecord): Promise<void> {
    if (record.state === "discarded") return;
    if (record.state === "executing") {
      throw runtimeError(
        "preparation.executing",
        "An executing preparation cannot be discarded.",
      );
    }
    if (record.cleanup) return record.cleanup;
    record.state = "discarding";
    record.cleanup = Promise.resolve()
      .then(() => record.entry.backend.discard(record.preparation))
      .catch((cause) => {
        throw runtimeError(
          "preparation.discard-error",
          `Backend preparation cleanup failed: ${errorMessage(cause)}`,
          [],
          cause,
        );
      })
      .finally(() => {
        record.state = "discarded";
        this.#preparedRecords.delete(record);
      });
    return record.cleanup;
  }

  async #dispatch(run: RunRecord): Promise<void> {
    const { prepared } = run;
    let candidate: RunResult | undefined;
    let cleanupError: unknown;
    let preparationDiscardInvoked = false;
    let preparationDiscardError: unknown;
    const discardPreparation = async (): Promise<void> => {
      if (preparationDiscardInvoked) return;
      preparationDiscardInvoked = true;
      try {
        await prepared.entry.backend.discard(prepared.preparation);
      } catch (cause) {
        preparationDiscardError = cause;
        throw cause;
      }
    };
    this.#emit(run, {
      phase: "starting",
      message: "Backend execution is starting.",
    });

    try {
      if (run.cancellation) {
        run.backendSettled = true;
        candidate = this.#cancellationResult(run);
        await discardPreparation();
      } else {
        const execution = await prepared.entry.backend.start(
          {
            plan: structuredClone(prepared.plan),
            preparation: prepared.preparation,
          },
          {
            emit: (event) => this.#emit(run, event),
            signal: run.controller.signal,
          },
        );
        if (!isBackendExecution(execution)) {
          throw runtimeError(
            "execution.invalid-control",
            "Backend returned invalid execution controls.",
          );
        }
        run.execution = execution;
        if (!run.cancellation) run.state = "running";
        else this.#requestBackendCancellation(run);

        let backendResult: BackendResult | undefined;
        try {
          backendResult = await execution.result;
        } catch (cause) {
          if (!run.cancellation) {
            throw runtimeError(
              "execution.backend-error",
              `Backend execution failed: ${errorMessage(cause)}`,
              [],
              cause,
            );
          }
        }
        run.backendSettled = true;
        this.#clearTimeout(run);
        candidate = run.cancellation
          ? this.#cancellationResult(run)
          : backendResult
            ? this.#normalizeBackendResult(run, backendResult)
            : this.#failureResult(
                run,
                "execution.internal",
                "Backend settled without a terminal result.",
              );
      }
    } catch (cause) {
      run.backendSettled = true;
      this.#clearTimeout(run);
      candidate = run.cancellation
        ? this.#cancellationResult(run)
        : this.#failureResult(
            run,
            cause instanceof ExecutionRuntimeError
              ? cause.code
              : "execution.backend-error",
            errorMessage(cause),
          );
      if (!run.execution) {
        try {
          await discardPreparation();
        } catch (discardCause) {
          cleanupError = discardCause;
        }
      }
    } finally {
      if (run.cancelPromise) {
        try {
          await run.cancelPromise;
        } catch {
          // Backend execution disposal remains authoritative for cleanup.
        }
      }
      if (run.execution) {
        try {
          await run.execution.dispose();
        } catch (cause) {
          cleanupError = cause;
        }
      }
    }

    cleanupError ??= preparationDiscardError;
    if (cleanupError) {
      candidate = this.#failureResult(
        run,
        "execution.cleanup-error",
        `Backend execution cleanup failed: ${errorMessage(cleanupError)}`,
      );
    }
    this.#settle(run, candidate ?? this.#failureResult(
      run,
      "execution.internal",
      "Execution reached cleanup without a terminal result.",
    ));
  }

  #normalizeBackendResult(
    run: RunRecord,
    backendResult: BackendResult,
  ): RunResult {
    let value: unknown;
    try {
      value = structuredClone(backendResult);
    } catch {
      return this.#failureResult(
        run,
        "execution.invalid-result",
        "Backend result is not structured-cloneable.",
      );
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return this.#failureResult(
        run,
        "execution.invalid-result",
        "Backend returned a malformed terminal result.",
      );
    }
    const candidate = {
      ...(value as Record<string, unknown>),
      ...this.#resultIdentityCommon(run),
    } as unknown as RunResult;
    const diagnostics = validateRunResult(candidate, run.prepared.plan);
    diagnostics.push(...validateBackendTerminalLimit(candidate, run.prepared.plan));
    if (hasErrors(diagnostics)) {
      return this.#failureResult(
        run,
        "execution.invalid-result",
        summarizeDiagnostics(diagnostics),
      );
    }
    return candidate;
  }

  #cancellationResult(run: RunRecord): RunResult {
    const cancellation = run.cancellation ?? {
      kind: "cancelled" as const,
      reason: "cancelled",
    };
    if (cancellation.kind === "timed-out") {
      const timeout = run.prepared.plan.preflight.limits.timeoutMs;
      return {
        ...this.#resultCommon(run),
        status: "timed-out",
        reason: cancellation.reason,
        enforcedTimeoutMs: timeout?.value ?? 1,
      };
    }
    return {
      ...this.#resultCommon(run),
      status: "cancelled",
      reason: cancellation.reason,
    };
  }

  #failureResult(
    run: RunRecord,
    code: string,
    message: string,
  ): RunResult {
    return {
      ...this.#resultCommon(run),
      status: "failed",
      error: {
        code,
        message,
        retryable: false,
      },
    };
  }

  #resultCommon(run: RunRecord) {
    return {
      ...this.#resultIdentityCommon(run),
      enforcement: {
        access: structuredClone(run.prepared.plan.preflight.access),
        limits: structuredClone(run.prepared.plan.preflight.limits),
      },
    };
  }

  #resultIdentityCommon(run: RunRecord) {
    const plan = run.prepared.plan;
    return {
      schemaVersion: EXECUTION_CONTRACT_VERSION,
      runId: run.id,
      preparedRunId: plan.preparedRunId,
      backendId: plan.backendId,
      conversationFingerprint: plan.conversationFingerprint,
      executionFingerprint: plan.executionFingerprint,
      model: structuredClone(plan.preflight.model),
      effectiveToolIds: plan.effectiveTools.map(
        ({ backendToolId }) => backendToolId,
      ),
      durationMs: elapsed(this.#now(), run.startedAtMs),
    };
  }

  async #cancelRun(
    run: RunRecord,
    kind: Cancellation["kind"],
    reason?: string,
  ): Promise<void> {
    if (run.settled || run.backendSettled) {
      await run.result;
      return;
    }
    if (!run.cancellation) {
      const normalizedReason =
        typeof reason === "string" && reason.trim()
          ? reason
          : kind === "timed-out"
            ? "host timeout"
            : "user";
      run.cancellation = { kind, reason: normalizedReason };
      run.state = "cancelling";
      this.#clearTimeout(run);
      run.controller.abort(normalizedReason);
      this.#requestBackendCancellation(run);
    }
    await run.result;
  }

  #requestBackendCancellation(run: RunRecord): void {
    if (!run.execution || !run.cancellation || run.cancelPromise) return;
    const execution = run.execution;
    const reason = run.cancellation.reason;
    run.cancelPromise = Promise.resolve().then(() =>
      execution.cancel(reason),
    );
    void run.cancelPromise.catch(() => undefined);
  }

  #settle(run: RunRecord, result: RunResult): void {
    if (run.settled) return;
    run.settled = true;
    run.state = "settled";
    run.settledAtMs = this.#now();
    this.#clearTimeout(run);
    run.prepared.state = "discarded";
    this.#preparedRecords.delete(run.prepared);
    this.#runs.delete(run);
    run.resolveResult(result);
    run.listeners.clear();
  }

  #emit(
    run: RunRecord,
    event: {
      phase: string;
      message: unknown;
      details?: unknown;
    },
  ): void {
    if (
      run.settled ||
      !["starting", "message", "tool-result", "finishing"].includes(event.phase) ||
      typeof event.message !== "string"
    ) {
      return;
    }
    let details: unknown;
    if (Object.hasOwn(event, "details")) {
      try {
        details = structuredClone(event.details);
      } catch {
        return;
      }
    }
    const normalized: RunEvent = {
      runId: run.id,
      sequence: ++run.sequence,
      timestamp: new Date(this.#now()).toISOString(),
      phase: event.phase as RunEvent["phase"],
      message: event.message,
      ...(Object.hasOwn(event, "details") ? { details } : {}),
    };
    for (const listener of [...run.listeners]) {
      try {
        listener(structuredClone(normalized));
      } catch {
        // Observers cannot affect execution.
      }
    }
  }

  #subscribe(run: RunRecord, listener: RunEventListener): Disposable {
    if (typeof listener !== "function") {
      throw runtimeError(
        "execution.listener",
        "Run event listener must be a function.",
      );
    }
    if (run.settled) return { dispose() {} };
    run.listeners.add(listener);
    let active = true;
    return {
      dispose: () => {
        if (!active) return;
        active = false;
        run.listeners.delete(listener);
      },
    };
  }

  #runSnapshot(run: RunRecord): RunSnapshot {
    return {
      id: run.id,
      preparedRunId: run.prepared.plan.preparedRunId,
      backendId: run.prepared.plan.backendId,
      state: run.state,
      startedAt: new Date(run.startedAtMs).toISOString(),
      ...(run.settledAtMs === undefined
        ? {}
        : { settledAt: new Date(run.settledAtMs).toISOString() }),
      ...(run.cancellation
        ? { cancellationReason: run.cancellation.reason }
        : {}),
    };
  }

  #clearTimeout(run: RunRecord): void {
    if (!run.timeout) return;
    clearTimeout(run.timeout);
    delete run.timeout;
  }

  #newId(kind: "prepared" | "run"): string {
    const id = this.#idFactory(kind);
    if (!OPAQUE_ID_PATTERN.test(id)) {
      throw runtimeError(
        "runtime.id-invalid",
        `idFactory returned an invalid ${kind} id.`,
      );
    }
    if (this.#issuedIds.has(id)) {
      throw runtimeError(
        "runtime.id-duplicate",
        `idFactory reused id ${id}.`,
      );
    }
    this.#issuedIds.add(id);
    return id;
  }

  #assertOpen(): void {
    if (this.#disposed) {
      throw runtimeError(
        "runtime.disposed",
        "Execution runtime has been disposed.",
      );
    }
  }
}

class PreparedRunHandle implements PreparedRun {
  readonly id: string;
  readonly backendId: string;
  readonly conversationFingerprint: Fingerprint;
  readonly executionFingerprint: Fingerprint;
  readonly #plan: SealedPlanSnapshot;
  readonly #discard: () => Promise<void>;

  constructor(
    plan: SealedPlanSnapshot,
    discard: () => Promise<void>,
  ) {
    this.id = plan.preparedRunId;
    this.backendId = plan.backendId;
    this.conversationFingerprint = plan.conversationFingerprint;
    this.executionFingerprint = plan.executionFingerprint;
    this.#plan = plan;
    this.#discard = discard;
    Object.freeze(this);
  }

  snapshot(): SealedPlanSnapshot {
    return structuredClone(this.#plan);
  }

  discard(): Promise<void> {
    return this.#discard();
  }
}

class RuntimeRunHandle implements RunHandle {
  readonly id: string;
  readonly result: Promise<RunResult>;
  readonly #snapshot: () => RunSnapshot;
  readonly #subscribe: (listener: RunEventListener) => Disposable;
  readonly #cancel: (reason?: string) => Promise<void>;

  constructor(
    id: string,
    snapshot: () => RunSnapshot,
    subscribe: (listener: RunEventListener) => Disposable,
    cancel: (reason?: string) => Promise<void>,
    result: Promise<RunResult>,
  ) {
    this.id = id;
    this.#snapshot = snapshot;
    this.#subscribe = subscribe;
    this.#cancel = cancel;
    this.result = result;
    Object.freeze(this);
  }

  snapshot(): RunSnapshot {
    return structuredClone(this.#snapshot());
  }

  subscribe(listener: RunEventListener): Disposable {
    return this.#subscribe(listener);
  }

  cancel(reason?: string): Promise<void> {
    return this.#cancel(reason);
  }
}

function validateBackendImplementation(
  backend: ExecutionBackend,
): void {
  if (!backend || typeof backend !== "object") {
    throw runtimeError(
      "backend.type",
      "Backend registration requires an object.",
    );
  }
  for (const method of ["preflight", "prepare", "start", "discard"] as const) {
    if (typeof backend[method] !== "function") {
      throw runtimeError(
        "backend.method",
        `Backend must implement ${method}().`,
      );
    }
  }
}

function createPreparationOperation(): PreparationOperation {
  let complete!: () => void;
  const completion = new Promise<void>((resolve) => {
    complete = resolve;
  });
  return {
    controller: new AbortController(),
    completion,
    complete,
  };
}

function bindEffectiveTools(
  preflight: BackendPreflightAccepted,
  requestedTools: readonly string[],
): EffectiveTool[] {
  const byName = new Map(
    preflight.toolCatalog.map((tool) => [tool.name, tool]),
  );
  return requestedTools.map((requestedName) => {
    const tool = byName.get(requestedName);
    if (!tool) {
      throw runtimeError(
        "preparation.tool-binding",
        `Accepted preflight is missing requested tool ${requestedName}.`,
      );
    }
    return {
      requestedName,
      backendToolId: tool.id,
      backendToolName: tool.name,
    };
  });
}

function bindPreparation(
  returned: BackendPreparation,
  runtime: PromptRuntime,
  conversation: PreparedConversation,
): BackendPreparation {
  if (
    !canonicalValuesEqual(returned.runtime, runtime) ||
    !canonicalValuesEqual(returned.conversation, conversation)
  ) {
    throw runtimeError(
      "preparation.compiler-mismatch",
      "Backend preparation changed before it could be bound.",
    );
  }
  deepFreeze(returned.runtime);
  deepFreeze(returned.conversation);
  return Object.freeze(returned);
}

async function discardAfterFailure(
  entry: BackendEntry,
  preparation: unknown,
): Promise<void> {
  if (!preparation || typeof preparation !== "object") return;
  try {
    await entry.backend.discard(preparation as BackendPreparation);
  } catch (cause) {
    throw runtimeError(
      "preparation.cleanup-error",
      `Backend cleanup failed after preparation error: ${errorMessage(cause)}`,
      [],
      cause,
    );
  }
}

function isBackendPreparation(value: unknown): value is BackendPreparation {
  return (
    !!value &&
    typeof value === "object" &&
    "runtime" in value &&
    "conversation" in value
  );
}

function isBackendExecution(value: unknown): value is BackendExecution {
  return (
    !!value &&
    typeof value === "object" &&
    "result" in value &&
    value.result instanceof Promise &&
    "cancel" in value &&
    typeof value.cancel === "function" &&
    "dispose" in value &&
    typeof value.dispose === "function"
  );
}

function validateBackendTerminalLimit(
  result: RunResult,
  plan: SealedPlanSnapshot,
): Diagnostic[] {
  if (result.status === "timed-out") {
    const timeout = plan.preflight.limits.timeoutMs;
    if (
      !timeout ||
      timeout.enforcement !== "backend-hard" ||
      result.enforcedTimeoutMs !== timeout.value
    ) {
      return [{
        level: "error",
        code: "result.timeout-binding",
        message:
          "Backend timeout result does not match a backend-hard accepted timeout.",
        path: "enforcedTimeoutMs",
      }];
    }
  }
  if (result.status === "limit-reached") {
    const limit = plan.preflight.limits[result.reachedLimit];
    if (!limit || limit.enforcement !== "backend-hard") {
      return [{
        level: "error",
        code: "result.limit-binding",
        message:
          "Backend limit result does not match a backend-hard accepted limit.",
        path: "reachedLimit",
      }];
    }
  }
  return [];
}

function cloneCanonical<T>(
  value: T,
  code: string,
  message: string,
): T {
  try {
    canonicalJson(value);
    return structuredClone(value);
  } catch (cause) {
    throw runtimeError(code, message, [], cause);
  }
}

function canonicalValuesEqual(left: unknown, right: unknown): boolean {
  try {
    return canonicalJson(left) === canonicalJson(right);
  } catch {
    return false;
  }
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child);
  }
  return value;
}

function elapsed(now: number, startedAt: number): number {
  return Math.max(0, now - startedAt);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function summarizeDiagnostics(diagnostics: readonly Diagnostic[]): string {
  return diagnostics
    .slice(0, 5)
    .map(({ code, message }) => `${code}: ${message}`)
    .join("; ");
}

function runtimeError(
  code: string,
  message: string,
  diagnostics: readonly Diagnostic[] = [],
  cause?: unknown,
): ExecutionRuntimeError {
  return cause === undefined
    ? new ExecutionRuntimeError(code, message, diagnostics)
    : new ExecutionRuntimeError(code, message, diagnostics, { cause });
}
