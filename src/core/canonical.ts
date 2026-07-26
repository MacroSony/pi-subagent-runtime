import { createHash } from "node:crypto";
import {
  FINGERPRINT_PREFIX,
  type Fingerprint,
  type PreparedConversation,
  type PromptRuntime,
  type SealedPlanSnapshot,
} from "./contracts.ts";

export function canonicalJson(value: unknown): string {
  return canonicalize(value, "$", new Set<object>());
}

export function fingerprint(value: unknown): Fingerprint {
  const digest = createHash("sha256")
    .update(canonicalJson(value))
    .digest("hex");
  return `${FINGERPRINT_PREFIX}${digest}`;
}

export function promptRuntimeFingerprint(
  runtime:
    | Omit<PromptRuntime, "promptRuntimeFingerprint">
    | PromptRuntime,
): Fingerprint {
  const { promptRuntimeFingerprint: _ignored, ...behavior } =
    runtime as PromptRuntime;
  return fingerprint(behavior);
}

export function conversationFingerprint(
  conversation: PreparedConversation,
): Fingerprint {
  return fingerprint(conversation);
}

export function executionFingerprint(
  plan:
    | Omit<SealedPlanSnapshot, "executionFingerprint">
    | SealedPlanSnapshot,
): Fingerprint {
  const { executionFingerprint: _ignored, ...behavior } =
    plan as SealedPlanSnapshot;
  return fingerprint(behavior);
}

function canonicalize(
  value: unknown,
  path: string,
  ancestors: Set<object>,
): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(`Cannot fingerprint non-finite number at ${path}.`);
    }
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (typeof value !== "object") {
    throw new TypeError(`Cannot fingerprint ${typeof value} at ${path}.`);
  }
  if (ancestors.has(value)) {
    throw new TypeError(`Cannot fingerprint cyclic value at ${path}.`);
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const items: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) {
          throw new TypeError(
            `Cannot fingerprint sparse array item at ${path}[${index}].`,
          );
        }
        items.push(canonicalize(value[index], `${path}[${index}]`, ancestors));
      }
      return `[${items.join(",")}]`;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`Cannot fingerprint non-plain object at ${path}.`);
    }

    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort();
    const properties = keys.map((key) => {
      const property = canonicalize(
        record[key],
        `${path}.${key}`,
        ancestors,
      );
      return `${JSON.stringify(key)}:${property}`;
    });
    return `{${properties.join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}
