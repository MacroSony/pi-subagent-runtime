import {
  clampThinkingLevel,
  type Model,
  type ThinkingLevel,
} from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type {
  BackendDescriptor,
  BackendPreflightAccepted,
  Diagnostic,
  ExecutionIntent,
} from "../../core/index.ts";
import {
  READ_ONLY_PI_TOOL_CATALOG,
  SHARED_USER_ACCESS_CAPABILITIES,
} from "./process-report.ts";

export const VALID_PI_THINKING_LEVELS = new Set([
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

export interface ProcessPreflightEvaluation {
  diagnostics: Diagnostic[];
  model: Model<any> | undefined;
}

/**
 * Shared intent policy for the fresh-process Pi backends. A shared-user
 * child cannot honestly enforce isolation, network denial, media input,
 * process tools, or backend-hard limits, so those intents fail closed.
 */
export function evaluateProcessIntent(
  intent: ExecutionIntent,
  modelRegistry: ModelRegistry,
  codePrefix: string,
): ProcessPreflightEvaluation {
  const diagnostics: Diagnostic[] = [];
  const access = intent.access;
  if (
    access.level !== "read-only" ||
    access.workspaces.length !== 1 ||
    access.workspaces[0]?.mode !== "read-only"
  ) {
    diagnostics.push(
      errorDiagnostic(
        `${codePrefix}.access`,
        "The process backend requires one read-only workspace.",
        "access",
      ),
    );
  }
  if (
    access.workingDirectory?.workspaceHandle !== access.workspaces[0]?.handle ||
    access.workingDirectory?.path !== "."
  ) {
    diagnostics.push(
      errorDiagnostic(
        `${codePrefix}.cwd`,
        "The process backend requires the requested workspace root as its working directory.",
        "access.workingDirectory",
      ),
    );
  }
  if (access.executionBoundary !== "shared-user") {
    diagnostics.push(
      errorDiagnostic(
        `${codePrefix}.boundary`,
        "The process backend cannot enforce an isolated execution boundary.",
        "access.executionBoundary",
      ),
    );
  }
  if (access.network !== "allow") {
    diagnostics.push(
      errorDiagnostic(
        `${codePrefix}.network`,
        "A shared-user process cannot honestly enforce network deny.",
        "access.network",
      ),
    );
  }
  if (access.allowProcess === true) {
    diagnostics.push(
      errorDiagnostic(
        `${codePrefix}.process`,
        "The read-only process backend does not expose process tools.",
        "access.allowProcess",
      ),
    );
  }
  if ((intent.media?.length ?? 0) > 0) {
    diagnostics.push(
      errorDiagnostic(
        `${codePrefix}.media`,
        "The first process backends support text tasks only.",
        "media",
      ),
    );
  }
  for (const name of ["maxTurns", "tokenBudget", "maxOutputBytes"] as const) {
    const requirement = intent.limits[name];
    if (requirement?.enforcement === "required") {
      diagnostics.push(
        errorDiagnostic(
          `${codePrefix}.limit`,
          `${name} cannot be enforced by the process backend.`,
          `limits.${name}`,
        ),
      );
    } else if (requirement) {
      diagnostics.push(
        warningDiagnostic(
          `${codePrefix}.limit-ignored`,
          `${name} is unsupported and will not be accepted.`,
          `limits.${name}`,
        ),
      );
    }
  }
  if (intent.limits.timeoutMs?.enforcement === "required") {
    diagnostics.push(
      errorDiagnostic(
        `${codePrefix}.limit`,
        "The process backend enforces timeouts only as host-abort, not backend-hard.",
        "limits.timeoutMs",
      ),
    );
  }

  if (intent.thinkingLevel === undefined) {
    diagnostics.push(
      errorDiagnostic(
        `${codePrefix}.thinking`,
        "The process backend requires an explicit thinking level.",
        "thinkingLevel",
      ),
    );
  } else if (!VALID_PI_THINKING_LEVELS.has(intent.thinkingLevel)) {
    diagnostics.push(
      errorDiagnostic(
        `${codePrefix}.thinking`,
        `Unsupported thinking level: ${intent.thinkingLevel}.`,
        "thinkingLevel",
      ),
    );
  }

  const catalogNames = new Set(
    READ_ONLY_PI_TOOL_CATALOG.map((tool) => tool.name),
  );
  for (const [index, requested] of intent.requestedTools.entries()) {
    if (!catalogNames.has(requested)) {
      diagnostics.push(
        errorDiagnostic(
          `${codePrefix}.tool`,
          `Requested tool is unavailable in the read-only process backend: ${requested}.`,
          `requestedTools[${index}]`,
        ),
      );
    }
  }

  const model = modelRegistry.find(intent.model.provider, intent.model.id);
  if (!model) {
    diagnostics.push(
      errorDiagnostic(
        `${codePrefix}.model`,
        `Unknown model: ${intent.model.provider}/${intent.model.id}`,
        "model",
      ),
    );
  } else {
    if (!modelRegistry.hasConfiguredAuth(model)) {
      diagnostics.push(
        errorDiagnostic(
          `${codePrefix}.auth`,
          `Model ${model.provider}/${model.id} has no configured authentication.`,
          "model",
        ),
      );
    }
    if (
      intent.thinkingLevel !== undefined &&
      VALID_PI_THINKING_LEVELS.has(intent.thinkingLevel)
    ) {
      const effectiveThinking = clampThinkingLevel(
        model,
        intent.thinkingLevel as ThinkingLevel,
      );
      if (effectiveThinking !== intent.thinkingLevel) {
        diagnostics.push(
          errorDiagnostic(
            `${codePrefix}.thinking`,
            `Model ${model.provider}/${model.id} would clamp thinking level ${intent.thinkingLevel} to ${effectiveThinking}.`,
            "thinkingLevel",
          ),
        );
      }
    }
  }

  return { diagnostics, model };
}

export function acceptedReadOnlyPreflight(input: {
  descriptor: BackendDescriptor;
  preflightId: string;
  intent: ExecutionIntent;
  model: Model<any>;
  diagnostics: Diagnostic[];
  codePrefix: string;
}): BackendPreflightAccepted {
  const { intent, diagnostics, codePrefix } = input;
  const workspace = intent.access.workspaces[0]!;
  const limits: BackendPreflightAccepted["limits"] = {};
  if (intent.limits.timeoutMs) {
    limits.timeoutMs = {
      value: intent.limits.timeoutMs.value,
      enforcement: "host-abort",
    };
  }
  diagnostics.push(
    warningDiagnostic(
      `${codePrefix}.shared-user`,
      "Read-only is enforced by the model-visible tool allowlist, not by OS isolation; the child process retains the invoking user's permissions.",
      "access",
    ),
  );
  return {
    status: "accepted",
    preflightId: input.preflightId,
    backend: structuredClone(input.descriptor),
    model: { provider: input.model.provider, id: input.model.id },
    ...(intent.thinkingLevel === undefined
      ? {}
      : { thinkingLevel: intent.thinkingLevel }),
    toolCatalog: structuredClone(READ_ONLY_PI_TOOL_CATALOG),
    access: {
      level: "read-only",
      mounts: [
        {
          workspaceHandle: workspace.handle,
          mountId: "host-workspace",
          mode: "read-only",
        },
      ],
      workingDirectory: { mountId: "host-workspace", path: "." },
      network: "allow",
      process: false,
      executionBoundary: "shared-user",
      enforcement: { ...SHARED_USER_ACCESS_CAPABILITIES },
    },
    limits,
    diagnostics,
  };
}

export function errorDiagnostic(
  code: string,
  message: string,
  path?: string,
): Diagnostic {
  return { level: "error", code, message, ...(path ? { path } : {}) };
}

export function warningDiagnostic(
  code: string,
  message: string,
  path?: string,
): Diagnostic {
  return { level: "warning", code, message, ...(path ? { path } : {}) };
}
