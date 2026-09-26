import assert from "node:assert/strict";
import test from "node:test";
import {
  appendProcessReportMessage,
  captureProcessAssistantReceipt,
  createProcessReport,
  processRunUsage,
  processReportSummary,
  sanitizeProcessRunReport,
} from "../src/backends/shared/process-report.ts";

function report() {
  return createProcessReport({
    preparedRunId: "prepared",
    executionFingerprint: "sha256:v1:report-test",
    model: { provider: "fixture", id: "model" },
    effectiveToolNames: [],
    workingDirectory: ".",
    startedAt: new Date(0).toISOString(),
  });
}

function assistant(usage?: Record<string, unknown>) {
  return {
    role: "assistant",
    content: [{ type: "text", text: "reply" }],
    ...(usage === undefined ? {} : { usage }),
  };
}

test("process usage preserves complete cache breakdown and request coverage", () => {
  const current = report();
  captureProcessAssistantReceipt(
    current,
    assistant({
      input: 10,
      output: 5,
      cacheRead: 3,
      cacheWrite: 1,
      totalTokens: 19,
      cost: { input: 1, output: 0.5, cacheRead: 0.25, cacheWrite: 0.25, total: 2 },
    }),
  );
  captureProcessAssistantReceipt(
    current,
    assistant({
      input: 4,
      output: 2,
      cacheRead: 6,
      cacheWrite: 0,
      totalTokens: 12,
      cost: { input: 0.5, output: 0.25, cacheRead: 0.125, cacheWrite: 0.125, total: 1 },
    }),
  );

  assert.deepEqual(processRunUsage(current.usage), {
    tokens: {
      input: 14,
      output: 7,
      total: 31,
      cacheRead: 9,
      cacheWrite: 1,
    },
    requests: { total: 2, cacheKnown: 2, usageKnown: 2 },
    cost: {
      amount: 3,
      currency: "USD",
      breakdown: {
        input: 1.5,
        output: 0.75,
        cacheRead: 0.375,
        cacheWrite: 0.375,
      },
    },
  });
});

test("missing or malformed cache fields remain unknown instead of becoming zero", () => {
  const current = report();
  captureProcessAssistantReceipt(
    current,
    assistant({ input: 4, output: 2, totalTokens: 6 }),
  );
  captureProcessAssistantReceipt(
    current,
    assistant({
      input: 3,
      output: 1,
      cacheRead: "not-a-count",
      cacheWrite: 0,
      totalTokens: 4,
    }),
  );

  const usage = processRunUsage(current.usage);
  assert.deepEqual(usage?.tokens, { input: 7, output: 3, total: 10 });
  assert.deepEqual(usage?.requests, { total: 2, cacheKnown: 0, usageKnown: 0 });
});

test("mixed cache coverage reports known totals and its incomplete coverage", () => {
  const current = report();
  captureProcessAssistantReceipt(
    current,
    assistant({
      input: 10,
      output: 2,
      cacheRead: 8,
      cacheWrite: 1,
      totalTokens: 21,
      cost: { input: 1, output: 0.5, cacheRead: 0.25, cacheWrite: 0.25, total: 2 },
    }),
  );
  captureProcessAssistantReceipt(current, assistant());

  const usage = processRunUsage(current.usage);
  assert.deepEqual(usage?.tokens, {
    input: 10,
    output: 2,
    total: 21,
    cacheRead: 8,
    cacheWrite: 1,
  });
  assert.deepEqual(usage?.requests, {
    total: 2,
    cacheKnown: 1,
    usageKnown: 1,
  });
  assert.deepEqual(usage?.cost, {
    amount: 2,
    currency: "USD",
    breakdown: { input: 1, output: 0.5, cacheRead: 0.25, cacheWrite: 0.25 },
  });
});

test("cache coverage requires valid input and output, not just cache fields", () => {
  const current = report();
  captureProcessAssistantReceipt(
    current,
    assistant({ input: "unknown", output: 2, cacheRead: 3, cacheWrite: 1, totalTokens: 6 }),
  );
  assert.deepEqual(processRunUsage(current.usage)?.requests, {
    total: 1,
    cacheKnown: 0,
    usageKnown: 0,
  });
});

test("inconsistent totals do not become a claimed native receipt", () => {
  const current = report();
  captureProcessAssistantReceipt(
    current,
    assistant({
      input: 10,
      output: 5,
      cacheRead: 3,
      cacheWrite: 1,
      totalTokens: 18,
      cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
    }),
  );
  assert.deepEqual(processRunUsage(current.usage), {
    tokens: {
      input: 10,
      output: 5,
      total: 18,
      cacheRead: 3,
      cacheWrite: 1,
    },
    requests: { total: 1, cacheKnown: 1, usageKnown: 0 },
    cost: { amount: 2, currency: "USD" },
  });
});

test("aggregate overflow is not clamped into exact usage", () => {
  const current = report();
  current.usage.input = Number.MAX_SAFE_INTEGER;
  captureProcessAssistantReceipt(
    current,
    assistant({ input: 1, output: 0, totalTokens: 1 }),
  );
  const usage = processRunUsage(current.usage);
  assert.equal(usage?.tokens, undefined);
  assert.deepEqual(usage?.requests, { total: 1, cacheKnown: 0, usageKnown: 0 });
});

test("partial cancelled/failed usage survives report retention truncation", () => {
  const cancelled = report();
  captureProcessAssistantReceipt(
    cancelled,
    assistant({ input: 5, output: 1, cacheRead: 2, cacheWrite: 0, totalTokens: 8 }),
  );
  cancelled.status = "cancelled";
  appendProcessReportMessage(
    cancelled,
    { role: "assistant", content: [{ type: "text", text: "x".repeat(600_000) }] },
    (value) => value,
  );
  assert.equal(cancelled.retention.truncated, true);
  assert.deepEqual(processRunUsage(cancelled.usage)?.requests, {
    total: 1,
    cacheKnown: 1,
    usageKnown: 0,
  });

  const failed = report();
  captureProcessAssistantReceipt(failed, assistant({ input: 2, output: 1, totalTokens: 3 }));
  failed.status = "failed";
  assert.deepEqual(processRunUsage(failed.usage)?.requests, {
    total: 1,
    cacheKnown: 0,
    usageKnown: 0,
  });
});

test("legacy receipts without totalTokens retain the input/output lower bound", () => {
  const current = report();
  captureProcessAssistantReceipt(current, assistant({ input: 10, output: 5 }));
  const usage = processRunUsage(current.usage);
  assert.deepEqual(usage?.tokens, { input: 10, output: 5, total: 15 });
  assert.equal(usage?.requests?.usageKnown, 0);
});


test("progress/report snapshots do not alias mutable cost subtotals", () => {
  const current = report();
  const receipt = assistant({
    input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
    cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
  });
  captureProcessAssistantReceipt(current, receipt);
  const summary = processReportSummary(current);
  const sanitized = sanitizeProcessRunReport(current, (value) => value);
  captureProcessAssistantReceipt(current, receipt);
  assert.equal(summary.usage.costBreakdown?.input, 1);
  assert.equal(sanitized.usage.costBreakdown?.input, 1);
  assert.equal(current.usage.costBreakdown?.input, 2);
});
