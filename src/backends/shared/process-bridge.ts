import { readFileSync, writeSync } from "node:fs";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ModelReference, PreparedMessage } from "../../core/index.ts";
import {
  SUBPROCESS_REPORT_FD_ENV,
  sanitizeSubprocessReportValue,
} from "./report-sanitize.ts";

export const SUBPROCESS_BRIDGE_INPUT_ENV = "PI_SUBAGENT_RUNTIME_BRIDGE_INPUT";

export interface SubprocessBridgeInput {
  marker: string;
  systemPrompt: string;
  messages: readonly PreparedMessage[];
  model: ModelReference;
  effectiveToolNames: readonly string[];
}

export interface SubprocessBridgeReportEvent {
  type: "message_end";
  message: unknown;
}

export interface SubprocessBridgeOptions {
  report?: (event: SubprocessBridgeReportEvent) => void;
}

export function loadSubprocessBridgeInput(
  path = process.env[SUBPROCESS_BRIDGE_INPUT_ENV],
): SubprocessBridgeInput {
  if (!path) throw new Error(`Missing ${SUBPROCESS_BRIDGE_INPUT_ENV}.`);
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<SubprocessBridgeInput>;
  if (typeof parsed.marker !== "string" || !parsed.marker) {
    throw new Error("Subprocess bridge input is missing its marker.");
  }
  if (typeof parsed.systemPrompt !== "string") {
    throw new Error("Subprocess bridge input is missing its system prompt.");
  }
  if (!Array.isArray(parsed.messages) || parsed.messages.length === 0) {
    throw new Error("Subprocess bridge input has no prepared messages.");
  }
  if (
    !parsed.model ||
    typeof parsed.model.provider !== "string" ||
    typeof parsed.model.id !== "string"
  ) {
    throw new Error("Subprocess bridge input has no model receipt.");
  }
  if (
    !Array.isArray(parsed.effectiveToolNames) ||
    parsed.effectiveToolNames.some((name) => typeof name !== "string")
  ) {
    throw new Error("Subprocess bridge input has an invalid tool allowlist.");
  }
  return parsed as SubprocessBridgeInput;
}

/**
 * Trusted bridge installed as the only extension inside the child process.
 * It replaces the unique marker prompt with the sealed ordered messages,
 * installs the exact compiled system prompt, blocks tool calls outside the
 * sealed allowlist, and streams sanitized message events to the report fd.
 */
export function createSubprocessBridge(
  input: SubprocessBridgeInput,
  options: SubprocessBridgeOptions = {},
) {
  return (pi: ExtensionAPI): void => {
    let markerObserved = false;
    const report = options.report ?? writeSubprocessReportEvent;
    pi.on("before_agent_start", () => ({ systemPrompt: input.systemPrompt }));
    pi.on("context", (event) => {
      const markerIndex = event.messages.findIndex((message) =>
        isMarkerMessage(message, input.marker),
      );
      if (markerIndex === -1) {
        if (!markerObserved) {
          throw new Error(
            "Subagent runtime process marker was absent before the first provider request.",
          );
        }
        return;
      }
      markerObserved = true;
      return {
        messages: [
          ...event.messages.slice(0, markerIndex),
          ...input.messages.map((message, index) =>
            preparedMessageToAgentMessage(message, input.model, index),
          ),
          ...event.messages.slice(markerIndex + 1),
        ],
      };
    });
    pi.on("tool_call", (event) => {
      if (!input.effectiveToolNames.includes(event.toolName)) {
        return {
          block: true,
          reason: `Tool ${event.toolName} is outside the approved subagent runtime process allowlist.`,
        };
      }
    });
    pi.on("message_end", (event) => {
      report({
        type: "message_end",
        message: sanitizeSubprocessReportValue(event.message),
      });
    });
  };
}

function writeSubprocessReportEvent(event: SubprocessBridgeReportEvent): void {
  const rawFd = process.env[SUBPROCESS_REPORT_FD_ENV];
  const fd = rawFd ? Number(rawFd) : Number.NaN;
  if (!Number.isSafeInteger(fd) || fd < 3) {
    throw new Error(`Missing or invalid ${SUBPROCESS_REPORT_FD_ENV}.`);
  }
  writeSync(fd, `${JSON.stringify(event)}\n`, undefined, "utf8");
}

function isMarkerMessage(message: AgentMessage, marker: string): boolean {
  if (message.role !== "user") return false;
  if (typeof message.content === "string") return message.content === marker;
  return (
    message.content.length === 1 &&
    message.content[0]?.type === "text" &&
    message.content[0].text === marker
  );
}

function preparedMessageToAgentMessage(
  message: PreparedMessage,
  model: ModelReference,
  index: number,
): AgentMessage {
  if (message.content.some((part) => part.type === "media")) {
    throw new Error("Subprocess media preparation is not implemented.");
  }
  const content = message.content.map((part) => ({
    type: "text" as const,
    text: part.type === "text" ? part.text : "",
  }));
  if (message.role === "user") {
    return {
      role: "user",
      content: content.length === 1 ? content[0]!.text : content,
      timestamp: index,
    } as AgentMessage;
  }
  if (message.role === "custom") {
    return {
      role: "custom",
      customType: "pi-subagent-runtime",
      content,
      display: false,
      details: {},
      timestamp: index,
    } as AgentMessage;
  }
  return {
    role: "assistant",
    content,
    api: "unknown",
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: index,
  } as AgentMessage;
}

export default function subprocessBridge(pi: ExtensionAPI): void {
  createSubprocessBridge(loadSubprocessBridgeInput())(pi);
}
