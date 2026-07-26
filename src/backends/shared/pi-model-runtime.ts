import {
  ModelRuntime,
  type ModelRegistry,
} from "@earendil-works/pi-coding-agent";

/**
 * Pi 0.82.1 exposes ModelRegistry to extensions as a compatibility facade,
 * while createAgentSession requires the canonical ModelRuntime. The facade
 * retains that runtime internally but does not yet publish a typed accessor.
 *
 * This Pi-version coupling is deliberately confined to this backend entry
 * point; the portable core never references Pi SDK types.
 */
export function modelRuntimeFromRegistry(
  modelRegistry: ModelRegistry,
): ModelRuntime {
  const candidate = (modelRegistry as unknown as { runtime?: unknown })
    .runtime;
  if (!isModelRuntime(candidate)) {
    throw new Error(
      "The subprocess backend cannot access the Pi 0.82.1 model runtime required to preserve caller authentication. " +
        "Use the exact supported Pi version before preparing a subprocess run.",
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
