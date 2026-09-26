import type {
  AccessCapabilities,
  BackendTool,
  ExecutionBoundary,
  Fingerprint,
  ModelReference,
  RunUsage,
} from "../../core/index.ts";

export const MAX_RETAINED_PROCESS_REPORT_BYTES = 512 * 1024;
export const MAX_PROCESS_STDERR_BYTES = 64 * 1024;

export interface ProcessRunUsage {
  /** Legacy totals of individually valid fields; coverage is reported separately. */
  input: number;
  output: number;
  totalTokens: number;
  cost: number;
  /** Sum of cache fields from receipts with valid input/output/cache fields. */
  cacheRead: number;
  /** Sum of cache fields from receipts with valid input/output/cache fields. */
  cacheWrite: number;
  /** Component costs from receipts with complete native usage. */
  costBreakdown?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  /** Assistant receipts observed; includes receipts without usage. */
  turns: number;
  /** Assistant receipts with valid input/output/cacheRead/cacheWrite fields. */
  cacheKnownTurns?: number;
  /** Assistant receipts with complete, internally consistent native usage. */
  usageKnownTurns?: number;
  /** Set when an exact aggregate cannot be represented safely. */
  tokenTotalsOverflow?: boolean;
  cacheTotalsOverflow?: boolean;
  costOverflow?: boolean;
  costBreakdownOverflow?: boolean;
  turnsOverflow?: boolean;
}

export interface ProcessRunReport {
  preparedRunId: string;
  executionFingerprint: Fingerprint;
  status: "running" | "completed" | "failed" | "cancelled";
  startedAt: string;
  finishedAt?: string;
  exitCode?: number;
  signal?: NodeJS.Signals;
  model: ModelReference;
  thinkingLevel?: string;
  effectiveToolNames: string[];
  executionBoundary: ExecutionBoundary;
  workingDirectory: string;
  messages: unknown[];
  retention: {
    maxBytes: number;
    retainedBytes: number;
    truncated: boolean;
    omittedMessages: number;
  };
  stderr: string;
  usage: ProcessRunUsage;
  stopReason?: string;
  errorMessage?: string;
}

export function createProcessReport(input: {
  preparedRunId: string;
  executionFingerprint: Fingerprint;
  model: ModelReference;
  thinkingLevel?: string;
  effectiveToolNames: readonly string[];
  workingDirectory: string;
  startedAt: string;
  executionBoundary?: ExecutionBoundary;
}): ProcessRunReport {
  return {
    preparedRunId: input.preparedRunId,
    executionFingerprint: input.executionFingerprint,
    status: "running",
    startedAt: input.startedAt,
    model: structuredClone(input.model),
    ...(input.thinkingLevel === undefined
      ? {}
      : { thinkingLevel: input.thinkingLevel }),
    effectiveToolNames: [...input.effectiveToolNames],
    executionBoundary: input.executionBoundary ?? "shared-user",
    workingDirectory: input.workingDirectory,
    messages: [],
    retention: createRetention(),
    stderr: "",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: 0,
      costBreakdown: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
      },
      turns: 0,
      cacheKnownTurns: 0,
      usageKnownTurns: 0,
    },
  };
}

export function processReportSummary(report: ProcessRunReport): Omit<
  ProcessRunReport,
  "messages" | "stderr"
> & { messageCount: number; stderrBytes: number } {
  const { messages, stderr, ...rest } = report;
  return {
    ...rest,
    usage: structuredClone(report.usage),
    effectiveToolNames: [...report.effectiveToolNames],
    messageCount: messages.length,
    stderrBytes: Buffer.byteLength(stderr, "utf8"),
  };
}

export function appendProcessReportMessage(
  report: ProcessRunReport,
  value: unknown,
  sanitize: (value: unknown) => unknown,
): void {
  let message = sanitize(value);
  let messageBytes = serializedBytes(message);
  if (messageBytes > report.retention.maxBytes) {
    message = summarizeOversizedMessage(message, messageBytes);
    messageBytes = serializedBytes(message);
    report.retention.truncated = true;
    report.retention.omittedMessages += 1;
  }
  report.messages.push(message);
  report.retention.retainedBytes += messageBytes;
  while (
    report.retention.retainedBytes > report.retention.maxBytes &&
    report.messages.length > 1
  ) {
    const removed = report.messages.shift();
    report.retention.retainedBytes -= serializedBytes(removed);
    report.retention.truncated = true;
    report.retention.omittedMessages += 1;
  }
}

export function sanitizeProcessRunReport(
  report: ProcessRunReport,
  sanitize: (value: unknown) => unknown,
): ProcessRunReport {
  const sanitized: ProcessRunReport = {
    ...report,
    model: { ...report.model },
    effectiveToolNames: [...report.effectiveToolNames],
    messages: [],
    retention: createRetention(report.retention?.omittedMessages ?? 0),
    stderr: appendBounded(
      "",
      String(sanitize(report.stderr)),
      MAX_PROCESS_STDERR_BYTES,
    ),
    usage: structuredClone(report.usage),
  };
  for (const message of report.messages) {
    appendProcessReportMessage(sanitized, message, sanitize);
  }
  return sanitized;
}

export function captureProcessAssistantReceipt(
  report: ProcessRunReport,
  value: unknown,
): void {
  if (!isRecord(value) || value.role !== "assistant") return;
  const turns = addSafeInteger(report.usage.turns, 1);
  if (turns === undefined) report.usage.turnsOverflow = true;
  else report.usage.turns = turns;

  if (isRecord(value.usage)) {
    const usage = value.usage;
    if (isSafeNonNegativeInteger(usage.input)) {
      report.usage.input = addTokenTotal(report.usage, "input", usage.input);
    }
    if (isSafeNonNegativeInteger(usage.output)) {
      report.usage.output = addTokenTotal(report.usage, "output", usage.output);
    }
    if (isSafeNonNegativeInteger(usage.totalTokens)) {
      report.usage.totalTokens = addTokenTotal(
        report.usage,
        "totalTokens",
        usage.totalTokens,
      );
    }

    if (isCacheKnownUsage(usage)) {
      const cacheRead = addSafeInteger(report.usage.cacheRead, usage.cacheRead);
      const cacheWrite = addSafeInteger(report.usage.cacheWrite, usage.cacheWrite);
      if (cacheRead === undefined || cacheWrite === undefined) {
        report.usage.cacheTotalsOverflow = true;
      } else {
        report.usage.cacheRead = cacheRead;
        report.usage.cacheWrite = cacheWrite;
      }
      const known = addSafeInteger(report.usage.cacheKnownTurns ?? 0, 1);
      if (known === undefined) report.usage.turnsOverflow = true;
      else report.usage.cacheKnownTurns = known;
    }

    const cost = isRecord(usage.cost) ? usage.cost : undefined;
    if (cost && isNonNegativeFinite(cost.total)) {
      const total = addFinite(report.usage.cost, cost.total);
      if (total === undefined) report.usage.costOverflow = true;
      else report.usage.cost = total;
    }

    if (isCompleteNativeUsage(usage)) {
      const breakdown = (report.usage.costBreakdown ??= {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
      });
      const input = addFinite(breakdown.input, usage.cost.input);
      const output = addFinite(breakdown.output, usage.cost.output);
      const cacheRead = addFinite(breakdown.cacheRead, usage.cost.cacheRead);
      const cacheWrite = addFinite(breakdown.cacheWrite, usage.cost.cacheWrite);
      if (
        input === undefined ||
        output === undefined ||
        cacheRead === undefined ||
        cacheWrite === undefined
      ) {
        report.usage.costBreakdownOverflow = true;
      } else {
        breakdown.input = input;
        breakdown.output = output;
        breakdown.cacheRead = cacheRead;
        breakdown.cacheWrite = cacheWrite;
      }
      const known = addSafeInteger(report.usage.usageKnownTurns ?? 0, 1);
      if (known === undefined) report.usage.turnsOverflow = true;
      else report.usage.usageKnownTurns = known;
    }
  }
  if (typeof value.stopReason === "string") {
    report.stopReason = value.stopReason;
  }
  if (typeof value.errorMessage === "string") {
    report.errorMessage = value.errorMessage;
  }
}

export function processRunUsage(
  usage: ProcessRunUsage,
): RunUsage | undefined {
  if (
    usage.turns === 0 ||
    !isSafeNonNegativeInteger(usage.turns) ||
    usage.turnsOverflow
  ) {
    return undefined;
  }
  const requests = usage.turns;
  if (
    !isSafeNonNegativeInteger(usage.cacheKnownTurns ?? 0) ||
    !isSafeNonNegativeInteger(usage.usageKnownTurns ?? 0) ||
    (usage.cacheKnownTurns ?? 0) > requests ||
    (usage.usageKnownTurns ?? 0) > requests
  ) {
    return undefined;
  }
  const result: RunUsage = {
    requests: {
      total: requests,
      cacheKnown: usage.cacheKnownTurns ?? 0,
      usageKnown: usage.usageKnownTurns ?? 0,
    },
  };

  const minimumTotal = addSafeInteger(usage.input, usage.output);
  if (!usage.tokenTotalsOverflow && minimumTotal !== undefined) {
    result.tokens = {
      input: usage.input,
      output: usage.output,
      // Preserve the legacy lower bound for incomplete receipts. Coverage is
      // measured before this fallback, so it never makes usage native-known.
      total: Math.max(usage.totalTokens, minimumTotal),
    };
    // These are exact subtotals for cache-known receipts. They are details
    // only until coverage proves that the whole run is native-compatible.
    if ((usage.cacheKnownTurns ?? 0) > 0 && !usage.cacheTotalsOverflow) {
      result.tokens.cacheRead = usage.cacheRead;
      result.tokens.cacheWrite = usage.cacheWrite;
    }
  }

  if (!usage.costOverflow) {
    result.cost = { amount: usage.cost, currency: "USD" };
    if (
      (usage.usageKnownTurns ?? 0) > 0 &&
      !usage.costBreakdownOverflow &&
      usage.costBreakdown !== undefined
    ) {
      result.cost.breakdown = { ...usage.costBreakdown };
    }
  }
  return result;
}

export function latestProcessAssistantText(messages: unknown[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (
      !isRecord(message) ||
      message.role !== "assistant" ||
      !Array.isArray(message.content)
    ) {
      continue;
    }
    const text = message.content
      .filter(isRecord)
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => String(part.text))
      .join("");
    if (text.trim()) return text.trim();
  }
  return "";
}

export function processToolResultSummary(value: unknown): string {
  if (!isRecord(value)) return "Subagent tool result received.";
  const name = typeof value.toolName === "string" ? value.toolName : "tool";
  const error = value.isError === true ? " failed" : " completed";
  return `${name}${error}.`;
}

export function appendBounded(
  current: string,
  addition: string,
  maxBytes: number,
): string {
  const remaining = maxBytes - Buffer.byteLength(current, "utf8");
  if (remaining <= 0) return current;
  const bytes = Buffer.from(addition, "utf8");
  return current + bytes.subarray(0, remaining).toString("utf8");
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export const SHARED_USER_ACCESS_CAPABILITIES: AccessCapabilities = {
  readOnlyMountIsolation: false,
  readWriteMountIsolation: false,
  symlinkSafeContainment: false,
  processIsolation: false,
  agentNetworkIsolation: false,
};

export const READ_ONLY_PI_TOOL_CATALOG: readonly BackendTool[] = [
  {
    id: "pi.read",
    name: "read",
    description: "Read a file.",
    effects: ["filesystem-read"],
    adapterMapping: "pi:read",
  },
  {
    id: "pi.grep",
    name: "grep",
    description: "Search file contents.",
    effects: ["filesystem-read"],
    adapterMapping: "pi:grep",
  },
  {
    id: "pi.find",
    name: "find",
    description: "Find files by pattern.",
    effects: ["filesystem-read"],
    adapterMapping: "pi:find",
  },
  {
    id: "pi.ls",
    name: "ls",
    description: "List directory contents.",
    effects: ["filesystem-read"],
    adapterMapping: "pi:ls",
  },
];

function createRetention(
  omittedMessages = 0,
): ProcessRunReport["retention"] {
  return {
    maxBytes: MAX_RETAINED_PROCESS_REPORT_BYTES,
    retainedBytes: 0,
    truncated: omittedMessages > 0,
    omittedMessages,
  };
}

function summarizeOversizedMessage(
  value: unknown,
  originalBytes: number,
): unknown {
  if (!isRecord(value)) {
    return `[Oversized subagent report message omitted: ${originalBytes} bytes]`;
  }
  const role = typeof value.role === "string" ? value.role : "custom";
  const summary: Record<string, unknown> = {
    role,
    content: [
      {
        type: "text",
        text: `[Oversized subagent report message compacted: ${originalBytes} bytes]`,
      },
    ],
    reportDataOmitted: true,
    originalBytes,
  };
  if (typeof value.toolName === "string") summary.toolName = value.toolName;
  if (typeof value.toolCallId === "string") summary.toolCallId = value.toolCallId;
  if (value.isError === true) summary.isError = true;
  if (role === "assistant") {
    const text = assistantText(value);
    if (text) summary.content = [{ type: "text", text }];
  }
  return summary;
}

function assistantText(value: Record<string, unknown>): string {
  if (!Array.isArray(value.content)) return "";
  return value.content
    .filter(isRecord)
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => String(part.text))
    .join("");
}

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? "null", "utf8");
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function addSafeInteger(current: number, value: number): number | undefined {
  const result = current + value;
  return Number.isSafeInteger(result) ? result : undefined;
}

function addFinite(current: number, value: number): number | undefined {
  const result = current + value;
  return Number.isFinite(result) ? result : undefined;
}

function addTokenTotal(
  usage: ProcessRunUsage,
  field: "input" | "output" | "totalTokens",
  value: number,
): number {
  const result = addSafeInteger(usage[field], value);
  if (result === undefined) usage.tokenTotalsOverflow = true;
  return result ?? usage[field];
}

function isCacheKnownUsage(
  usage: Record<string, unknown>,
): usage is Record<string, unknown> & {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
} {
  return (
    isSafeNonNegativeInteger(usage.input) &&
    isSafeNonNegativeInteger(usage.output) &&
    isSafeNonNegativeInteger(usage.cacheRead) &&
    isSafeNonNegativeInteger(usage.cacheWrite)
  );
}

function isCompleteNativeUsage(
  usage: Record<string, unknown>,
): usage is Record<string, unknown> & {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
} {
  if (
    !isCacheKnownUsage(usage) ||
    !isSafeNonNegativeInteger(usage.totalTokens) ||
    !isRecord(usage.cost) ||
    !isNonNegativeFinite(usage.cost.input) ||
    !isNonNegativeFinite(usage.cost.output) ||
    !isNonNegativeFinite(usage.cost.cacheRead) ||
    !isNonNegativeFinite(usage.cost.cacheWrite) ||
    !isNonNegativeFinite(usage.cost.total)
  ) {
    return false;
  }
  const tokenTotal = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
  return Number.isSafeInteger(tokenTotal) && usage.totalTokens === tokenTotal;
}
