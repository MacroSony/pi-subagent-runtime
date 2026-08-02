import {
  ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";

/** Minimal host-owned model registry surface required by the process backends. */
export interface PiModelRegistry {
  find(provider: string, modelId: string): Model<any> | undefined;
  hasConfiguredAuth(model: Model<any>): boolean;
}

/**
 * Pi exposes ModelRegistry to extensions as a compatibility facade, while
 * createAgentSession requires the canonical ModelRuntime. Current hosts retain
 * that runtime internally but do not publish a typed accessor.
 *
 * Keep this host coupling capability-based and confined to the process backend
 * entry points; the portable core never references Pi SDK types.
 */
export function modelRuntimeFromRegistry(
  modelRegistry: PiModelRegistry,
): ModelRuntime {
  const candidate = (modelRegistry as unknown as { runtime?: unknown })
    .runtime;
  if (!isModelRuntime(candidate)) {
    throw new Error(
      "The Pi process backend could not obtain a compatible authenticated ModelRuntime from the host ModelRegistry. " +
        "Pass modelRuntime explicitly or use a Pi host that exposes the required model runtime capabilities.",
    );
  }
  return candidate;
}

function isModelRuntime(value: unknown): value is ModelRuntime {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.getModel === "function" &&
    typeof candidate.getAuth === "function" &&
    typeof candidate.streamSimple === "function"
  );
}
