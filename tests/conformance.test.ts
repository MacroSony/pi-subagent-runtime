import assert from "node:assert/strict";
import test from "node:test";
import {
  BackendConformanceError,
  DeterministicFakeBackend,
  fakeExecutionIntent,
  fakePreparedConversation,
  runBackendConformance,
} from "../src/testing/index.ts";

test("reusable backend conformance exercises execution and discard paths", async () => {
  for (const fidelity of [
    "exact-preflight",
    "backend-assisted",
  ] as const) {
    const backend = new DeterministicFakeBackend({ fidelity });
    const report = await runBackendConformance({
      backend,
      intent: () => fakeExecutionIntent(),
      compile: async () => fakePreparedConversation(),
    });
    assert.equal(report.backendId, backend.descriptor.id);
    assert.equal(report.result.status, "completed");
    assert.ok(report.eventCount >= 1);
    assert.equal(backend.startCalls.length, 1);
    assert.equal(backend.executionDisposeCalls.length, 1);
    assert.equal(backend.discardCalls.length, 3);
    assert.ok(report.checks.includes("pre-dispatch-cancellation"));
    assert.ok(report.checks.includes("runtime-disposal-of-preparation"));
  }
});

test("reusable backend conformance rejects malformed terminal behavior", async () => {
  for (const mode of ["invalid", "degraded-receipt"] as const) {
    const backend = new DeterministicFakeBackend();
    backend.executionMode = mode;
    await assert.rejects(
      () =>
        runBackendConformance({
          backend,
          intent: () => fakeExecutionIntent(),
          compile: async () => fakePreparedConversation(),
        }),
      (error: unknown) =>
        error instanceof BackendConformanceError &&
        /did not complete: failed/.test(error.message),
    );
  }
});
