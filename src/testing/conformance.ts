import {
  hasErrors,
  validateRunResult,
  validateSealedPlanSnapshot,
  type BackendPreflightAccepted,
  type ExecutionIntent,
  type PreparedConversation,
  type PromptRuntime,
  type RunResult,
  type SealedPlanSnapshot,
} from "../core/index.ts";
import {
  createExecutionRuntime,
  type ExecutionBackend,
} from "../runtime/index.ts";

export interface BackendConformanceFixture {
  backend: ExecutionBackend;
  intent(): ExecutionIntent;
  compile(
    runtime: PromptRuntime,
    preflight: BackendPreflightAccepted,
  ): Promise<PreparedConversation>;
}

export interface BackendConformanceReport {
  backendId: string;
  plan: SealedPlanSnapshot;
  result: RunResult;
  eventCount: number;
  checks: readonly string[];
}

export class BackendConformanceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BackendConformanceError";
  }
}

export async function runBackendConformance(
  fixture: BackendConformanceFixture,
): Promise<BackendConformanceReport> {
  let preparedId = 0;
  let runId = 0;
  let clock = Date.parse("2026-07-26T12:00:00.000Z");
  const runtime = createExecutionRuntime({
    idFactory: (kind) =>
      kind === "prepared"
        ? `conformance-prepared-${++preparedId}`
        : `conformance-run-${++runId}`,
    now: () => clock++,
  });
  const registration = runtime.registerBackend(fixture.backend);
  try {
    const descriptors = runtime.listBackends();
    requireCondition(
      descriptors.length === 1 &&
        descriptors[0]?.id === fixture.backend.descriptor.id,
      "Registered backend was not discoverable by its descriptor id.",
    );

    let compilerCalls = 0;
    const prepared = await runtime.prepare({
      backendId: fixture.backend.descriptor.id,
      intent: fixture.intent(),
      compile: async (promptRuntime, preflight) => {
        compilerCalls += 1;
        return fixture.compile(promptRuntime, preflight);
      },
    });
    requireCondition(
      compilerCalls === 1,
      `Host compiler was invoked ${compilerCalls} times; expected once.`,
    );
    const plan = prepared.snapshot();
    const planDiagnostics = validateSealedPlanSnapshot(plan);
    requireCondition(
      !hasErrors(planDiagnostics),
      `Prepared plan failed validation: ${summarize(planDiagnostics)}`,
    );

    let eventCount = 0;
    const run = runtime.execute(prepared);
    run.subscribe(() => {
      eventCount += 1;
    });
    const result = await run.result;
    const resultDiagnostics = validateRunResult(result, plan);
    requireCondition(
      !hasErrors(resultDiagnostics),
      `Terminal result failed validation: ${summarize(resultDiagnostics)}`,
    );
    requireCondition(
      result.status === "completed",
      `Conformance execution did not complete: ${result.status}.`,
    );

    const discardCandidate = await runtime.prepare({
      backendId: fixture.backend.descriptor.id,
      intent: fixture.intent(),
      compile: fixture.compile,
    });
    await discardCandidate.discard();

    const cancelCandidate = await runtime.prepare({
      backendId: fixture.backend.descriptor.id,
      intent: fixture.intent(),
      compile: fixture.compile,
    });
    const cancelledRun = runtime.execute(cancelCandidate);
    const cancellation = cancelledRun.cancel(
      "conformance cancellation before dispatch",
    );
    const cancelledResult = await cancelledRun.result;
    await cancellation;
    requireCondition(
      cancelledResult.status === "cancelled",
      `Pre-dispatch cancellation did not settle as cancelled: ${cancelledResult.status}.`,
    );

    await runtime.prepare({
      backendId: fixture.backend.descriptor.id,
      intent: fixture.intent(),
      compile: fixture.compile,
    });
    await runtime.dispose();

    return {
      backendId: fixture.backend.descriptor.id,
      plan,
      result,
      eventCount,
      checks: [
        "registration",
        "prepare-and-seal",
        "execute-and-dispose",
        "explicit-preparation-discard",
        "pre-dispatch-cancellation",
        "runtime-disposal-of-preparation",
      ],
    };
  } catch (cause) {
    if (cause instanceof BackendConformanceError) throw cause;
    throw new BackendConformanceError(
      `Backend conformance failed: ${errorMessage(cause)}`,
      { cause },
    );
  } finally {
    registration.dispose();
    await runtime.dispose();
  }
}

function requireCondition(
  condition: boolean,
  message: string,
): asserts condition {
  if (!condition) throw new BackendConformanceError(message);
}

function summarize(
  diagnostics: readonly { code: string; message: string }[],
): string {
  return diagnostics
    .slice(0, 5)
    .map(({ code, message }) => `${code}: ${message}`)
    .join("; ");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
