import { spawnSync } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, resolve } from "node:path";
import {
  clampThinkingLevel,
  type Model,
  type ThinkingLevel,
} from "@earendil-works/pi-ai";
import type {
  BackendDescriptor,
  BackendPreflightAccepted,
  Diagnostic,
  ExecutionIntent,
} from "../../core/index.ts";
import {
  VALID_PI_THINKING_LEVELS,
  errorDiagnostic,
} from "../shared/preflight-policy.ts";
import type { PiModelRegistry } from "../shared/pi-model-runtime.ts";

export const PI_BUBBLEWRAP_PROPOSAL_TOOL_CATALOG = [
  {
    id: "pi.read",
    name: "read",
    description: "Read a file from the proposal workspace.",
    effects: ["filesystem-read"] as const,
    adapterMapping: "pi:read",
  },
  {
    id: "pi.grep",
    name: "grep",
    description: "Search proposal workspace file contents.",
    effects: ["filesystem-read"] as const,
    adapterMapping: "pi:grep",
  },
  {
    id: "pi.find",
    name: "find",
    description: "Find files in the proposal workspace.",
    effects: ["filesystem-read"] as const,
    adapterMapping: "pi:find",
  },
  {
    id: "pi.ls",
    name: "ls",
    description: "List proposal workspace files.",
    effects: ["filesystem-read"] as const,
    adapterMapping: "pi:ls",
  },
  {
    id: "pi.edit",
    name: "edit",
    description: "Edit a file in the proposal workspace.",
    effects: ["filesystem-write"] as const,
    adapterMapping: "pi:edit",
  },
  {
    id: "pi.write",
    name: "write",
    description: "Write a file in the proposal workspace.",
    effects: ["filesystem-write"] as const,
    adapterMapping: "pi:write",
  },
  {
    id: "pi.bash",
    name: "bash",
    description:
      "Run a command in the isolated proposal workspace, including tests.",
    effects: [
      "filesystem-read",
      "filesystem-write",
      "process",
      "network",
    ] as const,
    adapterMapping: "pi:bash",
  },
] as const;

export interface BubblewrapPreflightEnvironment {
  cwd: string;
  workspaceRoots: Readonly<Record<string, string>>;
  bwrapPath?: string;
}

export interface BubblewrapPreflightEvaluation {
  diagnostics: Diagnostic[];
  model: Model<any> | undefined;
}

/**
 * Policy for the first Bubblewrap proposal backend. The backend accepts a
 * deliberately narrow intent because one logical workspace is copied and
 * mounted over the exact cwd that Pi used during prompt preparation.
 */
export function evaluateBubblewrapProposalIntent(
  intent: ExecutionIntent,
  modelRegistry: PiModelRegistry,
  environment: BubblewrapPreflightEnvironment,
  codePrefix: string,
): BubblewrapPreflightEvaluation {
  const diagnostics: Diagnostic[] = [];
  const access = intent.access;
  const workspace = access.workspaces[0];
  if (
    access.level !== "workspace-write" ||
    access.workspaces.length !== 1 ||
    workspace?.mode !== "read-write"
  ) {
    diagnostics.push(
      errorDiagnostic(
        `${codePrefix}.access`,
        "The Bubblewrap proposal backend requires one read-write workspace.",
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
        "The Bubblewrap proposal backend requires the workspace root as its working directory.",
        "access.workingDirectory",
      ),
    );
  }
  if (access.executionBoundary !== "isolated") {
    diagnostics.push(
      errorDiagnostic(
        `${codePrefix}.boundary`,
        "The Bubblewrap proposal backend requires an isolated execution boundary.",
        "access.executionBoundary",
      ),
    );
  }
  if (access.network !== "allow") {
    diagnostics.push(
      errorDiagnostic(
        `${codePrefix}.network`,
        "The first Bubblewrap proposal backend requires network allow for direct provider transport.",
        "access.network",
      ),
    );
  }
  if (access.allowProcess !== true) {
    diagnostics.push(
      errorDiagnostic(
        `${codePrefix}.process`,
        "The Bubblewrap proposal backend requires process permission so the agent can run tests with bash.",
        "access.allowProcess",
      ),
    );
  }
  if ((intent.media?.length ?? 0) > 0) {
    diagnostics.push(
      errorDiagnostic(
        `${codePrefix}.media`,
        "The first Bubblewrap proposal backend supports text tasks only.",
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
          `${name} cannot be enforced by the first Bubblewrap proposal backend.`,
          `limits.${name}`,
        ),
      );
    } else if (requirement) {
      diagnostics.push({
        level: "warning",
        code: `${codePrefix}.limit-ignored`,
        message: `${name} is unsupported and will not be accepted.`,
        path: `limits.${name}`,
      });
    }
  }
  if (intent.limits.timeoutMs?.enforcement === "required") {
    diagnostics.push(
      errorDiagnostic(
        `${codePrefix}.limit`,
        "The first Bubblewrap proposal backend enforces timeouts only as host-abort, not backend-hard.",
        "limits.timeoutMs",
      ),
    );
  }

  if (intent.thinkingLevel === undefined) {
    diagnostics.push(
      errorDiagnostic(
        `${codePrefix}.thinking`,
        "The Bubblewrap proposal backend requires an explicit thinking level.",
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

  const catalogNames = new Set<string>(
    PI_BUBBLEWRAP_PROPOSAL_TOOL_CATALOG.map((tool) => tool.name),
  );
  for (const [index, requested] of intent.requestedTools.entries()) {
    if (!catalogNames.has(requested)) {
      diagnostics.push(
        errorDiagnostic(
          `${codePrefix}.tool`,
          `Requested tool is unavailable in the Bubblewrap proposal backend: ${requested}.`,
          `requestedTools[${index}]`,
        ),
      );
    }
  }

  if (process.platform !== "linux") {
    diagnostics.push(
      errorDiagnostic(
        `${codePrefix}.platform`,
        "The Bubblewrap proposal backend is available only on Linux.",
      ),
    );
  }
  if (!environment.bwrapPath) {
    diagnostics.push(
      errorDiagnostic(
        `${codePrefix}.bwrap`,
        "Bubblewrap executable was not found. Configure bwrapPath or install bwrap.",
      ),
    );
  }
  if (workspace) {
    const configuredRoot = environment.workspaceRoots[workspace.handle];
    if (!configuredRoot) {
      diagnostics.push(
        errorDiagnostic(
          `${codePrefix}.workspace`,
          `No host path is configured for workspace ${workspace.handle}.`,
          "access.workspaces[0].handle",
        ),
      );
    } else if (!canonicalDirectory(configuredRoot)) {
      diagnostics.push(
        errorDiagnostic(
          `${codePrefix}.workspace`,
          `Configured workspace path is not a readable directory: ${configuredRoot}.`,
          "access.workspaces[0]",
        ),
      );
    } else if (!canonicalDirectory(environment.cwd)) {
      diagnostics.push(
        errorDiagnostic(
          `${codePrefix}.workspace-cwd`,
          "The first Bubblewrap proposal backend requires cwd to name an existing logical workspace path.",
          "access.workspaces[0]",
        ),
      );
    } else if (
      isSameOrDescendant(
        canonicalDirectory(tmpdir())!,
        canonicalDirectory(configuredRoot)!,
      )
    ) {
      diagnostics.push(
        errorDiagnostic(
          `${codePrefix}.workspace-temp-overlap`,
          "The configured workspace cannot contain the backend temporary directory.",
          "access.workspaces[0]",
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

export function acceptedBubblewrapProposalPreflight(input: {
  descriptor: BackendDescriptor;
  preflightId: string;
  intent: ExecutionIntent;
  model: Model<any>;
  diagnostics: readonly Diagnostic[];
}): BackendPreflightAccepted {
  const workspace = input.intent.access.workspaces[0]!;
  const limits: BackendPreflightAccepted["limits"] = {};
  if (input.intent.limits.timeoutMs) {
    limits.timeoutMs = {
      value: input.intent.limits.timeoutMs.value,
      enforcement: "host-abort",
    };
  }
  return {
    status: "accepted",
    preflightId: input.preflightId,
    backend: structuredClone(input.descriptor),
    model: { provider: input.model.provider, id: input.model.id },
    ...(input.intent.thinkingLevel === undefined
      ? {}
      : { thinkingLevel: input.intent.thinkingLevel }),
    toolCatalog: structuredClone(PI_BUBBLEWRAP_PROPOSAL_TOOL_CATALOG),
    access: {
      level: "workspace-write",
      mounts: [
        {
          workspaceHandle: workspace.handle,
          mountId: "proposal-workspace",
          mode: "read-write",
        },
      ],
      workingDirectory: { mountId: "proposal-workspace", path: "." },
      network: "allow",
      process: true,
      executionBoundary: "isolated",
      enforcement: {
        readOnlyMountIsolation: false,
        readWriteMountIsolation: true,
        symlinkSafeContainment: true,
        processIsolation: true,
        agentNetworkIsolation: false,
      },
    },
    limits,
    diagnostics: structuredClone(input.diagnostics),
  };
}

export function findBubblewrapExecutable(
  configuredPath: string | undefined,
  pathValue = process.env.PATH,
): string | undefined {
  if (configuredPath) {
    return isExecutable(configuredPath) ? resolve(configuredPath) : undefined;
  }
  if (!pathValue) return undefined;
  for (const directory of pathValue.split(delimiter)) {
    if (!directory) continue;
    const candidate = resolve(directory, "bwrap");
    if (isExecutable(candidate)) return candidate;
  }
  return undefined;
}

export function verifyBubblewrapExecutable(path: string): boolean {
  try {
    const result = spawnSync(path, ["--version"], {
      encoding: "utf8",
      timeout: 2_000,
      windowsHide: true,
    });
    if (result.error || result.status !== 0) return false;
    return /\bbubblewrap\s+\d/i.test(`${result.stdout}\n${result.stderr}`);
  } catch {
    return false;
  }
}

function canonicalDirectory(path: string): string | undefined {
  try {
    if (!statSync(path).isDirectory()) return undefined;
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

function isSameOrDescendant(path: string, ancestor: string): boolean {
  return path === ancestor || path.startsWith(`${ancestor}/`);
}

function isExecutable(path: string): boolean {
  try {
    const stat = statSync(isAbsolute(path) ? path : resolve(path));
    return stat.isFile() && (stat.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}
