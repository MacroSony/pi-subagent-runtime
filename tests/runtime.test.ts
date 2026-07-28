import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import test from "node:test";
import {
  createExecutionRuntime,
  ExecutionRuntimeError,
  type ExecutionBackend,
  type ExecutionRuntime,
  type PrepareRequest,
  type PreparedRun,
} from "../src/runtime/index.ts";
import {
  DeterministicFakeBackend,
  fakeExecutionIntent,
  fakePreparedConversation,
} from "../src/testing/index.ts";

function deterministicRuntime(): ExecutionRuntime {
  let prepared = 0;
  let run = 0;
  let now = Date.parse("2026-07-26T12:00:00.000Z");
  return createExecutionRuntime({
    idFactory: (kind) =>
      kind === "prepared" ? `prepared-${++prepared}` : `run-${++run}`,
    now: () => now++,
  });
}

function request(
  backend: DeterministicFakeBackend,
  overrides: Partial<PrepareRequest> = {},
): PrepareRequest {
  return {
    backendId: backend.descriptor.id,
    intent: fakeExecutionIntent(),
    compile: async () => fakePreparedConversation(),
    ...overrides,
  };
}

function runtimeError(code: string): (error: unknown) => boolean {
  return (error) =>
    error instanceof ExecutionRuntimeError && error.code === code;
}

async function waitFor(
  condition: () => boolean,
  timeoutMs = 1_000,
): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("Timed out waiting for test condition.");
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

test("backend registration is explicit, sorted, cloned, and disposable", async () => {
  const runtime = deterministicRuntime();
  const second = new DeterministicFakeBackend({ id: "z-backend" });
  const first = new DeterministicFakeBackend({ id: "a-backend" });
  const secondRegistration = runtime.registerBackend(second);
  runtime.registerBackend(first);

  const listed = runtime.listBackends();
  assert.deepEqual(
    listed.map(({ id }) => id),
    ["a-backend", "z-backend"],
  );
  listed[0]!.version = "mutated";
  assert.equal(runtime.listBackends()[0]!.version, "1.0.0");
  assert.throws(
    () => runtime.registerBackend(new DeterministicFakeBackend({
      id: "a-backend",
    })),
    runtimeError("backend.duplicate"),
  );

  secondRegistration.dispose();
  await assert.rejects(
    () => runtime.prepare(request(second)),
    runtimeError("backend.missing"),
  );
  await runtime.dispose();
});

test("accepted preflight IDs are scoped to backend identity", async () => {
  const runtime = deterministicRuntime();
  const first = new DeterministicFakeBackend({ id: "first-backend" });
  const second = new DeterministicFakeBackend({ id: "second-backend" });
  runtime.registerBackend(first);
  runtime.registerBackend(second);

  const firstPrepared = await runtime.prepare(request(first));
  const secondPrepared = await runtime.prepare(request(second));
  assert.equal(firstPrepared.snapshot().preflightId, "preflight-1");
  assert.equal(secondPrepared.snapshot().preflightId, "preflight-1");
  await firstPrepared.discard();
  await secondPrepared.discard();
  await runtime.dispose();
});

test("backend-assisted preparation seals an inspectable one-shot plan", async () => {
  const runtime = deterministicRuntime();
  const backend = new DeterministicFakeBackend();
  runtime.registerBackend(backend);
  const controller = new AbortController();
  let compilerCalls = 0;
  const prepared = await runtime.prepare(request(backend, {
    signal: controller.signal,
    compile: async (promptRuntime, preflight) => {
      compilerCalls += 1;
      assert.equal(promptRuntime.fidelity, "backend-assisted");
      assert.equal(preflight.status, "accepted");
      assert.equal(preflight.backend.id, backend.descriptor.id);
      assert.deepEqual(
        preflight.toolCatalog.map(({ name }) => name),
        ["echo", "read", "write", "shell", "web"],
      );
      preflight.preflightId = "caller-mutated";
      return fakePreparedConversation();
    },
  }));

  assert.equal(compilerCalls, 1);
  assert.equal(backend.compilerCalls, 1);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  assert.match(prepared.conversationFingerprint, /^sha256:v1:/);
  assert.match(prepared.executionFingerprint, /^sha256:v1:/);
  const snapshot = prepared.snapshot();
  assert.equal(snapshot.backendId, backend.descriptor.id);
  assert.equal(snapshot.preflightId, "preflight-1");
  assert.deepEqual(
    snapshot.effectiveTools.map(({ backendToolId }) => backendToolId),
    ["tool.read"],
  );

  snapshot.conversation.systemPrompt = "caller mutation";
  assert.notEqual(
    prepared.snapshot().conversation.systemPrompt,
    "caller mutation",
  );
  assert.throws(
    () => {
      (prepared as { id: string }).id = "mutated";
    },
    TypeError,
  );
  await prepared.discard();
  await runtime.dispose();
});

test("prepare rejects an already-aborted caller signal before preflight", async () => {
  const runtime = deterministicRuntime();
  const backend = new DeterministicFakeBackend();
  runtime.registerBackend(backend);
  const controller = new AbortController();
  controller.abort("caller cancelled");

  await assert.rejects(
    () => runtime.prepare(request(backend, { signal: controller.signal })),
    runtimeError("preflight.cancelled"),
  );
  assert.equal(backend.preflightCalls.length, 0);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  await runtime.dispose();
});

test("prepare relays caller abort during backend preflight and detaches it", async () => {
  const runtime = deterministicRuntime();
  const backend = new DeterministicFakeBackend();
  let markPreflightStarted!: () => void;
  const preflightStarted = new Promise<void>((resolve) => {
    markPreflightStarted = resolve;
  });
  const cancellableBackend: ExecutionBackend = backend;
  cancellableBackend.preflight = async (input) => {
    markPreflightStarted();
    await new Promise<void>((_resolve, reject) => {
      if (input.signal.aborted) {
        reject(new Error("Preflight observed abort."));
        return;
      }
      input.signal.addEventListener(
        "abort",
        () => reject(new Error("Preflight observed abort.")),
        { once: true },
      );
    });
    throw new Error("unreachable");
  };
  runtime.registerBackend(cancellableBackend);
  const controller = new AbortController();

  const preparing = runtime.prepare(request(backend, {
    signal: controller.signal,
  }));
  await preflightStarted;
  assert.equal(getEventListeners(controller.signal, "abort").length, 1);
  controller.abort("caller cancelled");
  await assert.rejects(preparing, runtimeError("preflight.cancelled"));
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  await runtime.dispose();
});

test("prepare relays caller abort during backend preparation and detaches it", async () => {
  const runtime = deterministicRuntime();
  const backend = new DeterministicFakeBackend();
  let markPreparationStarted!: () => void;
  const preparationStarted = new Promise<void>((resolve) => {
    markPreparationStarted = resolve;
  });
  backend.prepare = async (_input, context) => {
    markPreparationStarted();
    await new Promise<void>((_resolve, reject) => {
      if (context.signal.aborted) {
        reject(new Error("Preparation observed abort."));
        return;
      }
      context.signal.addEventListener(
        "abort",
        () => reject(new Error("Preparation observed abort.")),
        { once: true },
      );
    });
    throw new Error("unreachable");
  };
  runtime.registerBackend(backend);
  const controller = new AbortController();

  const preparing = runtime.prepare(request(backend, {
    signal: controller.signal,
  }));
  await preparationStarted;
  assert.equal(getEventListeners(controller.signal, "abort").length, 1);
  controller.abort("caller cancelled");
  await assert.rejects(preparing, runtimeError("preparation.cancelled"));
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  await runtime.dispose();
});

test("exact-preflight preparation uses the accepted prompt runtime", async () => {
  const runtime = deterministicRuntime();
  const backend = new DeterministicFakeBackend({
    fidelity: "exact-preflight",
  });
  runtime.registerBackend(backend);
  const prepared = await runtime.prepare(request(backend));
  const snapshot = prepared.snapshot();
  assert.equal(snapshot.promptRuntime.fidelity, "exact-preflight");
  assert.deepEqual(
    snapshot.promptRuntime,
    snapshot.preflight.promptRuntime,
  );
  await prepared.discard();
  await runtime.dispose();
});

test("invalid, rejected, and descriptor-mismatched preflights fail before compilation", async () => {
  for (const [mode, code] of [
    ["rejected", "preflight.rejected"],
    ["mismatched-descriptor", "preflight.invalid"],
    ["throw", "preflight.backend-error"],
  ] as const) {
    const runtime = deterministicRuntime();
    const backend = new DeterministicFakeBackend();
    backend.preflightMode = mode;
    runtime.registerBackend(backend);
    let compilerCalls = 0;
    await assert.rejects(
      () => runtime.prepare(request(backend, {
        compile: async () => {
          compilerCalls += 1;
          return fakePreparedConversation();
        },
      })),
      runtimeError(code),
    );
    assert.equal(compilerCalls, 0);
    await runtime.dispose();
  }

  const runtime = deterministicRuntime();
  const backend = new DeterministicFakeBackend();
  runtime.registerBackend(backend);
  await assert.rejects(
    () => runtime.prepare(request(backend, {
      intent: fakeExecutionIntent({
        requestedTools: ["missing"],
      }),
    })),
    runtimeError("preflight.invalid"),
  );
  assert.equal(backend.preparationCalls.length, 0);
  await runtime.dispose();
});

test("backend cannot bypass or alter the host compiler", async () => {
  for (const [mode, code] of [
    ["bypass", "preparation.compiler-bypass"],
    ["mismatch", "preparation.compiler-mismatch"],
    ["invalid", "preparation.invalid"],
  ] as const) {
    const runtime = deterministicRuntime();
    const backend = new DeterministicFakeBackend();
    backend.preparationMode = mode;
    runtime.registerBackend(backend);
    await assert.rejects(
      () => runtime.prepare(request(backend)),
      runtimeError(code),
    );
    assert.equal(backend.discardCalls.length, 1);
    await runtime.dispose();
  }
});

test("compiler and backend preparation failures remain failure-atomic", async () => {
  const compilerRuntime = deterministicRuntime();
  const compilerBackend = new DeterministicFakeBackend();
  compilerRuntime.registerBackend(compilerBackend);
  await assert.rejects(
    () => compilerRuntime.prepare(request(compilerBackend, {
      compile: async () => {
        throw new Error("Compiler failed.");
      },
    })),
    runtimeError("preparation.compiler-error"),
  );
  assert.equal(compilerBackend.failureAtomicCleanupCalls, 1);
  assert.equal(compilerBackend.discardCalls.length, 0);
  await compilerRuntime.dispose();

  const backendRuntime = deterministicRuntime();
  const backend = new DeterministicFakeBackend();
  backend.preparationMode = "throw-after-compile";
  backendRuntime.registerBackend(backend);
  await assert.rejects(
    () => backendRuntime.prepare(request(backend)),
    runtimeError("preparation.backend-error"),
  );
  assert.equal(backend.failureAtomicCleanupCalls, 1);
  assert.equal(backend.discardCalls.length, 0);
  await backendRuntime.dispose();
});

test("post-preparation ID failure discards backend resources", async () => {
  const runtime = createExecutionRuntime({
    idFactory: () => "invalid id",
  });
  const backend = new DeterministicFakeBackend();
  runtime.registerBackend(backend);
  await assert.rejects(
    () => runtime.prepare(request(backend)),
    runtimeError("runtime.id-invalid"),
  );
  assert.equal(backend.discardCalls.length, 1);
  await runtime.dispose();
});

test("run ID failure leaves the prepared handle discardable", async () => {
  const runtime = createExecutionRuntime({
    idFactory: (kind) =>
      kind === "prepared" ? "prepared-valid" : "invalid run id",
  });
  const backend = new DeterministicFakeBackend();
  runtime.registerBackend(backend);
  const prepared = await runtime.prepare(request(backend));
  assert.throws(
    () => runtime.execute(prepared),
    runtimeError("runtime.id-invalid"),
  );
  await prepared.discard();
  assert.equal(backend.discardCalls.length, 1);
  await runtime.dispose();
});

test("prepared handles are runtime-bound, discardable, and executable once", async () => {
  const runtime = deterministicRuntime();
  const otherRuntime = deterministicRuntime();
  const backend = new DeterministicFakeBackend();
  runtime.registerBackend(backend);
  otherRuntime.registerBackend(new DeterministicFakeBackend());
  const prepared = await runtime.prepare(request(backend));

  assert.throws(
    () => otherRuntime.execute(prepared),
    runtimeError("execution.unbound-handle"),
  );
  assert.throws(
    () => runtime.execute({
      ...prepared,
      snapshot: () => prepared.snapshot(),
      discard: () => prepared.discard(),
    } as PreparedRun),
    runtimeError("execution.unbound-handle"),
  );

  const run = runtime.execute(prepared);
  assert.throws(
    () => runtime.execute(prepared),
    runtimeError("execution.handle-consumed"),
  );
  await assert.rejects(
    () => prepared.discard(),
    runtimeError("preparation.executing"),
  );
  assert.equal((await run.result).status, "completed");
  await runtime.dispose();
  await otherRuntime.dispose();
});

test("discard is idempotent and unregister does not invalidate a prepared lease", async () => {
  const runtime = deterministicRuntime();
  const backend = new DeterministicFakeBackend();
  const registration = runtime.registerBackend(backend);
  const discarded = await runtime.prepare(request(backend));
  await discarded.discard();
  await discarded.discard();
  assert.equal(backend.discardCalls.length, 1);
  assert.throws(
    () => runtime.execute(discarded),
    runtimeError("execution.handle-consumed"),
  );

  const leased = await runtime.prepare(request(backend));
  registration.dispose();
  await assert.rejects(
    () => runtime.prepare(request(backend)),
    runtimeError("backend.missing"),
  );
  assert.equal((await runtime.execute(leased).result).status, "completed");
  await runtime.dispose();
});

test("execution delivers events and normalizes backend failures", async () => {
  for (const [mode, expectedStatus, expectedCode] of [
    ["completed", "completed", undefined],
    ["failed", "failed", "fake.provider"],
    ["throw-result", "failed", "execution.backend-error"],
    ["invalid", "failed", "execution.invalid-result"],
    ["degraded-receipt", "failed", "execution.invalid-result"],
    ["cleanup-throw", "failed", "execution.cleanup-error"],
  ] as const) {
    const runtime = deterministicRuntime();
    const backend = new DeterministicFakeBackend();
    backend.executionMode = mode;
    runtime.registerBackend(backend);
    const prepared = await runtime.prepare(request(backend));
    const run = runtime.execute(prepared);
    const events: string[] = [];
    run.subscribe((event) => {
      events.push(event.message);
      throw new Error("Observer errors are ignored.");
    });
    const result = await run.result;
    assert.equal(result.status, expectedStatus, mode);
    if (result.status === "failed" && expectedCode) {
      assert.equal(result.error.code, expectedCode, mode);
    }
    assert.ok(events.includes("Fake backend started."), mode);
    assert.equal(backend.executionDisposeCalls.length, 1, mode);
    assert.equal(run.snapshot().state, "settled", mode);
    await runtime.dispose();
  }
});

test("start failure discards preparation exactly once", async () => {
  const runtime = deterministicRuntime();
  const backend = new DeterministicFakeBackend();
  backend.executionMode = "throw-start";
  runtime.registerBackend(backend);
  const result = await runtime.execute(
    await runtime.prepare(request(backend)),
  ).result;
  assert.equal(result.status, "failed");
  assert.equal(backend.discardCalls.length, 1);
  assert.equal(backend.executionDisposeCalls.length, 0);
  await runtime.dispose();
});

test("cancellation wins a pending backend result and drains cleanup once", async () => {
  const runtime = deterministicRuntime();
  const backend = new DeterministicFakeBackend();
  backend.executionMode = "delayed";
  runtime.registerBackend(backend);
  const run = runtime.execute(await runtime.prepare(request(backend)));
  await backend.waitForStart();
  const cancellation = run.cancel("stop now");
  await waitFor(() => backend.cancelCalls.length === 1);
  assert.deepEqual(backend.cancelCalls, ["stop now"]);
  backend.releaseNextExecution();
  await cancellation;

  const result = await run.result;
  assert.equal(result.status, "cancelled");
  if (result.status === "cancelled") assert.equal(result.reason, "stop now");
  assert.equal(backend.executionDisposeCalls.length, 1);
  await run.cancel("again");
  assert.equal(backend.cancelCalls.length, 1);
  await runtime.dispose();
});

test("synchronous backend cancel failure cannot escape lifecycle arbitration", async () => {
  const runtime = deterministicRuntime();
  const backend = new DeterministicFakeBackend();
  backend.executionMode = "delayed";
  backend.cancelThrows = true;
  runtime.registerBackend(backend);
  const run = runtime.execute(await runtime.prepare(request(backend)));
  await backend.waitForStart();
  const cancellation = run.cancel("cancel despite adapter error");
  await waitFor(() => backend.cancelCalls.length === 1);
  backend.releaseNextExecution();
  await cancellation;
  assert.equal((await run.result).status, "cancelled");
  assert.equal(backend.executionDisposeCalls.length, 1);
  await runtime.dispose();
});

test("cancellation before backend dispatch discards without starting", async () => {
  const runtime = deterministicRuntime();
  const backend = new DeterministicFakeBackend();
  runtime.registerBackend(backend);
  const run = runtime.execute(await runtime.prepare(request(backend)));
  const cancellation = run.cancel("before dispatch");
  await cancellation;
  assert.equal((await run.result).status, "cancelled");
  assert.equal(backend.startCalls.length, 0);
  assert.equal(backend.discardCalls.length, 1);
  await runtime.dispose();
});

test("host-abort timeout wins a delayed result", async () => {
  const runtime = deterministicRuntime();
  const backend = new DeterministicFakeBackend({
    limitEnforcement: { timeoutMs: "host-abort" },
  });
  backend.executionMode = "delayed";
  runtime.registerBackend(backend);
  const prepared = await runtime.prepare(request(backend, {
    intent: fakeExecutionIntent({
      limits: {
        timeoutMs: { value: 5, enforcement: "best-effort" },
      },
    }),
  }));
  const run = runtime.execute(prepared);
  await backend.waitForStart();
  await waitFor(() => backend.cancelCalls.length === 1);
  backend.releaseNextExecution();
  const result = await run.result;
  assert.equal(result.status, "timed-out");
  if (result.status === "timed-out") {
    assert.equal(result.enforcedTimeoutMs, 5);
  }
  await runtime.dispose();
});

test("backend-hard terminal limits must match accepted receipts", async () => {
  for (const [mode, limits, expected] of [
    [
      "timed-out",
      { timeoutMs: { value: 20, enforcement: "required" } },
      "timed-out",
    ],
    [
      "limit-reached",
      { maxTurns: { value: 3, enforcement: "required" } },
      "limit-reached",
    ],
  ] as const) {
    const runtime = deterministicRuntime();
    const backend = new DeterministicFakeBackend();
    backend.executionMode = mode;
    runtime.registerBackend(backend);
    const result = await runtime.execute(
      await runtime.prepare(request(backend, {
        intent: fakeExecutionIntent({ limits }),
      })),
    ).result;
    assert.equal(result.status, expected);
    await runtime.dispose();
  }

  const runtime = deterministicRuntime();
  const backend = new DeterministicFakeBackend();
  backend.executionMode = "limit-reached";
  runtime.registerBackend(backend);
  const result = await runtime.execute(
    await runtime.prepare(request(backend)),
  ).result;
  assert.equal(result.status, "failed");
  if (result.status === "failed") {
    assert.equal(result.error.code, "execution.invalid-result");
  }
  await runtime.dispose();
});

test("runtime disposal discards prepared work and cancels active work", async () => {
  const runtime = deterministicRuntime();
  const backend = new DeterministicFakeBackend({ cancelSettles: true });
  backend.executionMode = "delayed";
  runtime.registerBackend(backend);
  const unused = await runtime.prepare(request(backend));
  const active = runtime.execute(await runtime.prepare(request(backend)));
  await backend.waitForStart();
  await runtime.dispose();

  assert.equal((await active.result).status, "cancelled");
  assert.equal(backend.cancelCalls.length, 1);
  assert.equal(backend.executionDisposeCalls.length, 1);
  assert.equal(backend.discardCalls.length, 1);
  await unused.discard();
  await assert.rejects(
    () => runtime.prepare(request(backend)),
    runtimeError("runtime.disposed"),
  );
});

test("runtime disposal waits for an already-running discard", async () => {
  const runtime = deterministicRuntime();
  const backend = new DeterministicFakeBackend();
  let releaseDiscard!: () => void;
  const discardGate = new Promise<void>((resolve) => {
    releaseDiscard = resolve;
  });
  let markDiscardStarted!: () => void;
  const discardStarted = new Promise<void>((resolve) => {
    markDiscardStarted = resolve;
  });
  const originalDiscard = backend.discard.bind(backend);
  backend.discard = async (preparation) => {
    originalDiscard(preparation);
    markDiscardStarted();
    await discardGate;
  };
  runtime.registerBackend(backend);
  const prepared = await runtime.prepare(request(backend));
  const discarding = prepared.discard();
  await discardStarted;

  let disposalSettled = false;
  const disposal = runtime.dispose().finally(() => {
    disposalSettled = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(disposalSettled, false);
  releaseDiscard();
  await discarding;
  await disposal;
  assert.equal(backend.discardCalls.length, 1);
});

test("runtime disposal aborts and waits for in-flight preparation", async () => {
  const runtime = deterministicRuntime();
  const backend = new DeterministicFakeBackend();
  let markPreparationStarted!: () => void;
  const preparationStarted = new Promise<void>((resolve) => {
    markPreparationStarted = resolve;
  });
  backend.prepare = async (_input, context) => {
    markPreparationStarted();
    await new Promise<void>((_resolve, reject) => {
      if (context.signal.aborted) {
        reject(new Error("Preparation observed abort."));
        return;
      }
      context.signal.addEventListener(
        "abort",
        () => reject(new Error("Preparation observed abort.")),
        { once: true },
      );
    });
    throw new Error("unreachable");
  };
  runtime.registerBackend(backend);
  const preparing = runtime.prepare(request(backend));
  await preparationStarted;
  const disposing = runtime.dispose();
  await assert.rejects(preparing, runtimeError("preparation.cancelled"));
  await disposing;
});
