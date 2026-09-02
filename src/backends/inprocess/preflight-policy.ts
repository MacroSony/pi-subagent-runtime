import { clampThinkingLevel, type Model } from "@earendil-works/pi-ai";
import type {
  BackendDescriptor,
  BackendPreflightAccepted,
  BackendTool,
  Diagnostic,
  ExecutionIntent,
} from "../../core/index.ts";
import {
  errorDiagnostic,
  VALID_PI_THINKING_LEVELS,
  warningDiagnostic,
} from "../shared/preflight-policy.ts";
import type { PiModelRegistry } from "../shared/pi-model-runtime.ts";
import {
  READ_ONLY_PI_TOOL_CATALOG,
  SHARED_USER_ACCESS_CAPABILITIES,
} from "../shared/process-report.ts";

/**
 * In-process tool surface: the same seven Pi built-ins the Bubblewrap backend
 * exposes, minus any isolation claim. Enforcement is the session's tool
 * allowlist (a same-process policy boundary), not an OS sandbox.
 */
export const PI_INPROCESS_TOOL_CATALOG: readonly BackendTool[] = [
  ...READ_ONLY_PI_TOOL_CATALOG,
  {
    id: "pi.edit",
    name: "edit",
    description: "Edit a file in the workspace.",
    effects: ["filesystem-write"],
    adapterMapping: "pi:edit",
  },
  {
    id: "pi.write",
    name: "write",
    description: "Write a file in the workspace.",
    effects: ["filesystem-write"],
    adapterMapping: "pi:write",
  },
  {
    id: "pi.bash",
    name: "bash",
    description: "Run a command with the invoking user's permissions.",
    effects: ["filesystem-read", "filesystem-write", "process", "network"],
    adapterMapping: "pi:bash",
  },
];

export interface InProcessPreflightEvaluation {
  diagnostics: Diagnostic[];
  model?: Model<any>;
}

/**
 * Shared-user in-process policy. The backend executes inside the host process
 * with the invoking user's full privileges, so it accepts read-only and
 * workspace-write access but must never claim an isolated boundary, network
 * denial, or any isolation enforcement it cannot provide.
 */
export function evaluateInProcessIntent(
  intent: ExecutionIntent,
  modelRegistry: PiModelRegistry,
  codePrefix: string,
): InProcessPreflightEvaluation {
  const diagnostics: Diagnostic[] = [];
  const access = intent.access;
  const workspace = access.workspaces[0];
  const level = access.level;
  if (
    (level !== "read-only" && level !== "workspace-write") ||
    access.workspaces.length !== 1 ||
    workspace?.mode !== (level === "read-only" ? "read-only" : "read-write")
  ) {
    diagnostics.push(
      errorDiagnostic(
        `${codePrefix}.access`,
        "The in-process backend requires exactly one workspace whose mode matches the access level.",
        "access",
      ),
    );
  }
  if (
    access.workingDirectory?.workspaceHandle !== workspace?.handle ||
    access.workingDirectory?.path !== "."
  ) {
    diagnostics.push(
      errorDiagnostic(
        `${codePrefix}.cwd`,
        "The in-process backend requires the requested workspace root as its working directory.",
        "access.workingDirectory",
      ),
    );
  }
  if (access.executionBoundary !== "shared-user") {
    diagnostics.push(
      errorDiagnostic(
        `${codePrefix}.boundary`,
        "The in-process backend cannot enforce an isolated execution boundary; use the Bubblewrap write backend for isolated execution.",
        "access.executionBoundary",
      ),
    );
  }
  if (access.network !== "allow") {
    diagnostics.push(
      errorDiagnostic(
        `${codePrefix}.network`,
        "An in-process backend shares the host network stack and cannot honestly enforce network deny.",
        "access.network",
      ),
    );
  }
  if ((intent.media?.length ?? 0) > 0) {
    diagnostics.push(
      errorDiagnostic(
        `${codePrefix}.media`,
        "The in-process backend supports text tasks only.",
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
          `${name} cannot be enforced by the in-process backend.`,
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
        "The in-process backend enforces timeouts only as host-abort, not backend-hard.",
        "limits.timeoutMs",
      ),
    );
  }
  if (intent.thinkingLevel === undefined) {
    diagnostics.push(
      errorDiagnostic(
        `${codePrefix}.thinking`,
        "The in-process backend requires an explicit thinking level.",
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
  const catalogNames = new Set(PI_INPROCESS_TOOL_CATALOG.map((tool) => tool.name));
  for (const [index, requested] of intent.requestedTools.entries()) {
    if (!catalogNames.has(requested)) {
      diagnostics.push(
        errorDiagnostic(
          `${codePrefix}.tool`,
          `Requested tool is unavailable in the in-process backend: ${requested}.`,
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
        intent.thinkingLevel as Parameters<typeof clampThinkingLevel>[1],
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
  return { diagnostics, ...(model ? { model } : {}) };
}

export function acceptedInProcessPreflight(input: {
  descriptor: BackendDescriptor;
  preflightId: string;
  intent: ExecutionIntent;
  model: Model<any>;
  diagnostics: Diagnostic[];
  codePrefix: string;
}): BackendPreflightAccepted {
  const { intent, diagnostics, codePrefix } = input;
  const workspace = intent.access.workspaces[0]!;
  const level = intent.access.level;
  const mode = level === "read-only" ? ("read-only" as const) : ("read-write" as const);
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
      "Access is enforced by the model-visible tool allowlist only; the subagent runs inside the host process with the invoking user's full permissions and no OS isolation.",
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
    toolCatalog: structuredClone(PI_INPROCESS_TOOL_CATALOG) as BackendTool[],
    access: {
      level,
      mounts: [
        {
          workspaceHandle: workspace.handle,
          mountId: "host-workspace",
          mode,
        },
      ],
      workingDirectory: { mountId: "host-workspace", path: "." },
      network: "allow",
      process: intent.access.allowProcess === true,
      executionBoundary: "shared-user",
      enforcement: { ...SHARED_USER_ACCESS_CAPABILITIES },
    },
    limits,
    diagnostics,
  };
}
