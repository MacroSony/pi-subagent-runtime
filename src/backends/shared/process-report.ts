import type {
  AccessCapabilities,
  BackendTool,
  Fingerprint,
  ModelReference,
  RunUsage,
} from "../../core/index.ts";

export const MAX_RETAINED_PROCESS_REPORT_BYTES = 512 * 1024;
export const MAX_PROCESS_STDERR_BYTES = 64 * 1024;

export interface ProcessRunUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: number;
  turns: number;
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
  executionBoundary: "shared-user";
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
    executionBoundary: "shared-user",
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
      turns: 0,
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
    usage: { ...report.usage },
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
    usage: { ...report.usage },
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
  report.usage.turns += 1;
  if (isRecord(value.usage)) {
    report.usage.input += numberOrZero(value.usage.input);
    report.usage.output += numberOrZero(value.usage.output);
    report.usage.cacheRead += numberOrZero(value.usage.cacheRead);
    report.usage.cacheWrite += numberOrZero(value.usage.cacheWrite);
    report.usage.totalTokens += numberOrZero(value.usage.totalTokens);
    if (isRecord(value.usage.cost)) {
      report.usage.cost += numberOrZero(value.usage.cost.total);
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
  if (usage.turns === 0) return undefined;
  const integer = (value: number): number =>
    Math.max(0, Math.round(Number.isFinite(value) ? value : 0));
  const input = integer(usage.input);
  const output = integer(usage.output);
  return {
    tokens: {
      input,
      output,
      total: Math.max(integer(usage.totalTokens), input + output),
    },
    cost: { amount: Math.max(0, usage.cost), currency: "USD" },
  };
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

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
