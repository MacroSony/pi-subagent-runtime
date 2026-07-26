import {
  canonicalJson,
  conversationFingerprint,
  executionFingerprint,
  promptRuntimeFingerprint,
} from "./canonical.ts";
import {
  EXECUTION_CONTRACT_VERSION,
  FINGERPRINT_PREFIX,
  LIMIT_NAMES,
  type AccessCapabilities,
  type AccessReceipt,
  type AccessRequest,
  type BackendDescriptor,
  type BackendPreflightAccepted,
  type Diagnostic,
  type ExecutionIntent,
  type Fingerprint,
  type LimitEnforcement,
  type LimitName,
  type LimitRequest,
  type LimitReceipt,
  type PreparedConversation,
  type PromptRuntime,
  type SealedPlanSnapshot,
  type ToolEffect,
} from "./contracts.ts";

export const OPAQUE_ID_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export const FINGERPRINT_PATTERN =
  /^sha256:v1:[a-f0-9]{64}$/;

const TOOL_EFFECTS: readonly ToolEffect[] = [
  "filesystem-read",
  "filesystem-write",
  "process",
  "network",
];

const LIMIT_ENFORCEMENTS: readonly LimitEnforcement[] = [
  "backend-hard",
  "host-abort",
  "best-effort",
  "unsupported",
];

const ACCESS_CAPABILITY_KEYS: readonly (keyof AccessCapabilities)[] = [
  "readOnlyMountIsolation",
  "readWriteMountIsolation",
  "symlinkSafeContainment",
  "processIsolation",
  "agentNetworkIsolation",
];

export function validateExecutionIntent(value: unknown): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  if (!isRecord(value)) {
    return [error("intent.type", "Execution intent must be an object.", "$")];
  }

  validateModelReference(value.model, "model", diagnostics);
  if (
    value.thinkingLevel !== undefined &&
    (typeof value.thinkingLevel !== "string" || !value.thinkingLevel.trim())
  ) {
    diagnostics.push(
      error(
        "intent.thinking-level",
        "thinkingLevel must be a non-empty string.",
        "thinkingLevel",
      ),
    );
  }

  validateUniqueNonEmptyStrings(
    value.requestedTools,
    "requestedTools",
    diagnostics,
  );
  diagnostics.push(...validateAccessRequest(value.access, "access"));
  diagnostics.push(...validateLimitRequest(value.limits, "limits"));

  if (value.media !== undefined) {
    if (!Array.isArray(value.media)) {
      diagnostics.push(
        error("intent.media", "media must be an array.", "media"),
      );
    } else {
      const ids = new Set<string>();
      value.media.forEach((item, index) => {
        const path = `media[${index}]`;
        validateMediaReference(item, path, diagnostics);
        if (isRecord(item) && typeof item.id === "string") {
          if (ids.has(item.id)) {
            diagnostics.push(
              error(
                "intent.media-duplicate",
                `Duplicate media id: ${item.id}.`,
                `${path}.id`,
              ),
            );
          }
          ids.add(item.id);
        }
      });
    }
  }

  if (value.provenance !== undefined) {
    if (!isRecord(value.provenance)) {
      diagnostics.push(
        error(
          "intent.provenance",
          "provenance must be a string record.",
          "provenance",
        ),
      );
    } else {
      for (const [key, item] of Object.entries(value.provenance)) {
        if (!key || typeof item !== "string") {
          diagnostics.push(
            error(
              "intent.provenance-entry",
              "Provenance keys must be non-empty and values must be strings.",
              `provenance.${key}`,
            ),
          );
        }
      }
    }
  }

  return diagnostics;
}

export function validateAccessRequest(
  value: unknown,
  path = "access",
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  if (!isRecord(value)) {
    return [error("access.type", "access must be an object.", path)];
  }

  if (!["none", "read-only", "workspace-write"].includes(String(value.level))) {
    diagnostics.push(
      error("access.level", "Unsupported access level.", `${path}.level`),
    );
  }
  if (
    value.executionBoundary !== "isolated" &&
    value.executionBoundary !== "shared-user"
  ) {
    diagnostics.push(
      error(
        "access.execution-boundary",
        "executionBoundary must be isolated or shared-user.",
        `${path}.executionBoundary`,
      ),
    );
  }
  if (!Array.isArray(value.workspaces)) {
    diagnostics.push(
      error(
        "access.workspaces",
        "workspaces must be an array.",
        `${path}.workspaces`,
      ),
    );
    return diagnostics;
  }

  const handles = new Set<string>();
  let hasWritable = false;
  value.workspaces.forEach((workspace, index) => {
    const workspacePath = `${path}.workspaces[${index}]`;
    if (!isRecord(workspace)) {
      diagnostics.push(
        error("access.workspace", "Workspace must be an object.", workspacePath),
      );
      return;
    }
    validateOpaqueId(workspace.handle, `${workspacePath}.handle`, diagnostics);
    if (typeof workspace.handle === "string") {
      if (handles.has(workspace.handle)) {
        diagnostics.push(
          error(
            "access.duplicate-workspace",
            `Duplicate workspace handle: ${workspace.handle}.`,
            `${workspacePath}.handle`,
          ),
        );
      }
      handles.add(workspace.handle);
    }
    if (
      workspace.mode !== "read-only" &&
      workspace.mode !== "read-write"
    ) {
      diagnostics.push(
        error(
          "access.workspace-mode",
          "Workspace mode must be read-only or read-write.",
          `${workspacePath}.mode`,
        ),
      );
    }
    if (workspace.mode === "read-write") hasWritable = true;
  });

  if (value.level === "none" && value.workspaces.length > 0) {
    diagnostics.push(
      error(
        "access.none-workspaces",
        "Access none cannot include workspaces.",
        `${path}.workspaces`,
      ),
    );
  }
  if (value.level === "read-only" && hasWritable) {
    diagnostics.push(
      error(
        "access.read-only-write",
        "Read-only access cannot request a read-write workspace.",
        `${path}.workspaces`,
      ),
    );
  }
  if (value.level === "workspace-write" && !hasWritable) {
    diagnostics.push(
      error(
        "access.write-missing",
        "workspace-write requires at least one read-write workspace.",
        `${path}.workspaces`,
      ),
    );
  }
  if (value.network !== "deny" && value.network !== "allow") {
    diagnostics.push(
      error(
        "access.network",
        "network must be deny or allow.",
        `${path}.network`,
      ),
    );
  }
  if (
    value.allowProcess !== undefined &&
    typeof value.allowProcess !== "boolean"
  ) {
    diagnostics.push(
      error(
        "access.process",
        "allowProcess must be boolean.",
        `${path}.allowProcess`,
      ),
    );
  }
  if (value.allowProcess === true && value.level !== "workspace-write") {
    diagnostics.push(
      error(
        "access.process-level",
        "Process access requires workspace-write.",
        `${path}.allowProcess`,
      ),
    );
  }

  if (value.workingDirectory !== undefined) {
    if (!isRecord(value.workingDirectory)) {
      diagnostics.push(
        error(
          "access.cwd",
          "workingDirectory must be an object.",
          `${path}.workingDirectory`,
        ),
      );
    } else {
      if (
        !handles.has(String(value.workingDirectory.workspaceHandle))
      ) {
        diagnostics.push(
          error(
            "access.cwd-workspace",
            "workingDirectory must reference a requested workspace.",
            `${path}.workingDirectory.workspaceHandle`,
          ),
        );
      }
      if (!isSafeRelativePath(value.workingDirectory.path, true)) {
        diagnostics.push(
          error(
            "access.cwd-path",
            "workingDirectory.path must be a normalized relative POSIX path.",
            `${path}.workingDirectory.path`,
          ),
        );
      }
    }
  }
  if (value.level === "none" && value.workingDirectory !== undefined) {
    diagnostics.push(
      error(
        "access.none-cwd",
        "Access none cannot include a workingDirectory.",
        `${path}.workingDirectory`,
      ),
    );
  }

  return diagnostics;
}

export function validateLimitRequest(
  value: unknown,
  path = "limits",
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  if (!isRecord(value)) {
    return [error("limits.type", "limits must be an object.", path)];
  }

  for (const [name, requirement] of Object.entries(value)) {
    if (!LIMIT_NAMES.includes(name as LimitName)) {
      diagnostics.push(
        error("limits.unknown", `Unknown limit: ${name}.`, `${path}.${name}`),
      );
      continue;
    }
    if (
      !isRecord(requirement) ||
      !isPositiveInteger(requirement.value) ||
      (requirement.enforcement !== "required" &&
        requirement.enforcement !== "best-effort")
    ) {
      diagnostics.push(
        error(
          "limits.requirement",
          "Each limit requires a positive integer value and required or best-effort enforcement.",
          `${path}.${name}`,
        ),
      );
    }
  }
  return diagnostics;
}

export function validateBackendDescriptor(value: unknown): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  validateBackendDescriptorAt(value, "$", diagnostics);
  return diagnostics;
}

export function validatePromptRuntime(
  value: unknown,
  expectedFidelity?: PromptRuntime["fidelity"],
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  validatePromptRuntimeAt(value, "$", diagnostics, expectedFidelity);
  return diagnostics;
}

export function validatePreparedConversation(value: unknown): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  validatePreparedConversationAt(value, "$", diagnostics);
  return diagnostics;
}

export function validateBackendPreflight(
  value: unknown,
  intent?: ExecutionIntent,
  registeredDescriptor?: BackendDescriptor,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  if (!isRecord(value)) {
    return [
      error(
        "preflight.type",
        "BackendPreflightResult must be an object.",
        "$",
      ),
    ];
  }
  if (value.status !== "accepted" && value.status !== "rejected") {
    return [
      error(
        "preflight.status",
        "status must be accepted or rejected.",
        "status",
      ),
    ];
  }

  validateOpaqueId(value.preflightId, "preflightId", diagnostics);
  validateBackendDescriptorAt(value.backend, "backend", diagnostics);
  validateDiagnosticArray(value.diagnostics, "diagnostics", diagnostics);

  if (
    registeredDescriptor &&
    isRecord(value.backend) &&
    !canonicalValuesEqual(value.backend, registeredDescriptor)
  ) {
    diagnostics.push(
      error(
        "preflight.backend-identity",
        "Preflight backend descriptor does not match its registered descriptor.",
        "backend",
      ),
    );
  }

  if (value.status === "rejected") {
    if (
      Array.isArray(value.diagnostics) &&
      !value.diagnostics.some(
        (item) => isRecord(item) && item.level === "error",
      )
    ) {
      diagnostics.push(
        error(
          "preflight.rejected-diagnostics",
          "A rejected preflight must include an error diagnostic.",
          "diagnostics",
        ),
      );
    }
    return diagnostics;
  }

  validateModelReference(value.model, "model", diagnostics);
  if (
    value.thinkingLevel !== undefined &&
    (typeof value.thinkingLevel !== "string" || !value.thinkingLevel.trim())
  ) {
    diagnostics.push(
      error(
        "preflight.thinking-level",
        "thinkingLevel must be a non-empty string.",
        "thinkingLevel",
      ),
    );
  }
  validateToolCatalog(value.toolCatalog, "toolCatalog", diagnostics);
  diagnostics.push(...validateAccessReceipt(value.access, "access"));
  diagnostics.push(...validateLimitReceipt(value.limits, "limits"));
  if (value.promptRuntime !== undefined) {
    validatePromptRuntimeAt(
      value.promptRuntime,
      "promptRuntime",
      diagnostics,
    );
  }

  const acceptedShapeIsValid = !hasErrors(diagnostics);
  if (Array.isArray(value.diagnostics)) {
    for (const item of value.diagnostics) {
      if (isRecord(item) && item.level === "error") {
        diagnostics.push(
          error(
            "preflight.accepted-error",
            "An accepted preflight cannot include error diagnostics.",
            "diagnostics",
          ),
        );
        break;
      }
    }
  }

  if (acceptedShapeIsValid) {
    diagnostics.push(
      ...validateAcceptedPreflightAgainstDescriptor(
        value as unknown as BackendPreflightAccepted,
      ),
    );
  }
  if (intent && acceptedShapeIsValid) {
    diagnostics.push(
      ...validateAcceptedPreflightAgainstIntent(
        value as unknown as BackendPreflightAccepted,
        intent,
      ),
    );
  }
  return diagnostics;
}

export function validateAcceptedPreflightAgainstIntent(
  preflight: BackendPreflightAccepted,
  intent: ExecutionIntent,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  if (
    preflight.model.provider !== intent.model.provider ||
    preflight.model.id !== intent.model.id
  ) {
    diagnostics.push(
      error(
        "preflight.model",
        "Accepted model does not match the execution intent.",
        "model",
      ),
    );
  }
  if (
    intent.thinkingLevel !== undefined &&
    preflight.thinkingLevel !== intent.thinkingLevel
  ) {
    diagnostics.push(
      error(
        "preflight.thinking-level-mismatch",
        "Accepted thinking level does not match the execution intent.",
        "thinkingLevel",
      ),
    );
  }

  diagnostics.push(
    ...validateAccessEnforcement(intent.access, preflight.access),
    ...validateLimitEnforcement(intent.limits, preflight.limits),
  );

  const toolsByName = new Map(
    preflight.toolCatalog.map((tool) => [tool.name, tool]),
  );
  for (const [index, requestedName] of intent.requestedTools.entries()) {
    const tool = toolsByName.get(requestedName);
    if (!tool) {
      diagnostics.push(
        error(
          "preflight.tool-missing",
          `Requested tool is unavailable: ${requestedName}.`,
          `requestedTools[${index}]`,
        ),
      );
      continue;
    }
    for (const effect of tool.effects) {
      if (!accessAllowsEffect(intent.access, effect)) {
        diagnostics.push(
          error(
            "preflight.tool-effect",
            `Tool ${requestedName} requires disallowed ${effect} access.`,
            `requestedTools[${index}]`,
          ),
        );
      }
    }
  }

  for (const [index, media] of (intent.media ?? []).entries()) {
    if (!preflight.backend.capabilities.mediaMimeTypes.includes(media.mimeType)) {
      diagnostics.push(
        error(
          "preflight.media-mime",
          `Backend does not support ${media.mimeType}.`,
          `media[${index}].mimeType`,
        ),
      );
    }
  }

  const fidelity = preflight.backend.capabilities.promptRuntimeFidelity;
  if (fidelity === "partial") {
    diagnostics.push(
      error(
        "preflight.prompt-fidelity",
        "Partial prompt-runtime fidelity cannot prepare an exact run.",
        "backend.capabilities.promptRuntimeFidelity",
      ),
    );
  }
  if (fidelity === "exact-preflight" && !preflight.promptRuntime) {
    diagnostics.push(
      error(
        "preflight.prompt-runtime",
        "An exact-preflight backend must provide its prompt runtime.",
        "promptRuntime",
      ),
    );
  }
  if (preflight.promptRuntime) {
    if (preflight.promptRuntime.fidelity !== fidelity) {
      diagnostics.push(
        error(
          "preflight.prompt-runtime-fidelity",
          "Prompt runtime fidelity does not match the backend descriptor.",
          "promptRuntime.fidelity",
        ),
      );
    }
    if (
      preflight.promptRuntime.model.provider !== preflight.model.provider ||
      preflight.promptRuntime.model.id !== preflight.model.id
    ) {
      diagnostics.push(
        error(
          "preflight.prompt-runtime-model",
          "Prompt runtime model does not match the accepted model.",
          "promptRuntime.model",
        ),
      );
    }
  }

  return diagnostics;
}

export function validateAcceptedPreflightAgainstDescriptor(
  preflight: BackendPreflightAccepted,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const advertised = preflight.backend.capabilities;
  if (
    !advertised.executionBoundaries.includes(
      preflight.access.executionBoundary,
    )
  ) {
    diagnostics.push(
      error(
        "preflight.execution-boundary-capability",
        "Access receipt execution boundary was not advertised by the backend.",
        "access.executionBoundary",
      ),
    );
  }
  for (const key of ACCESS_CAPABILITY_KEYS) {
    if (preflight.access.enforcement[key] && !advertised.access[key]) {
      diagnostics.push(
        error(
          "preflight.access-capability",
          `Access receipt claims unadvertised ${key} enforcement.`,
          `access.enforcement.${key}`,
        ),
      );
    }
  }
  for (const name of LIMIT_NAMES) {
    const receipt = preflight.limits[name];
    if (
      receipt &&
      !advertised.limits[name].includes(receipt.enforcement)
    ) {
      diagnostics.push(
        error(
          "preflight.limit-capability",
          `Limit receipt claims unadvertised ${receipt.enforcement} enforcement for ${name}.`,
          `limits.${name}.enforcement`,
        ),
      );
    }
  }
  return diagnostics;
}

export function validateAccessReceipt(
  value: unknown,
  path = "access",
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  if (!isRecord(value)) {
    return [error("access-receipt.type", "Access receipt must be an object.", path)];
  }

  if (!["none", "read-only", "workspace-write"].includes(String(value.level))) {
    diagnostics.push(
      error(
        "access-receipt.level",
        "Unsupported access level.",
        `${path}.level`,
      ),
    );
  }
  if (value.network !== "deny" && value.network !== "allow") {
    diagnostics.push(
      error(
        "access-receipt.network",
        "network must be deny or allow.",
        `${path}.network`,
      ),
    );
  }
  if (typeof value.process !== "boolean") {
    diagnostics.push(
      error(
        "access-receipt.process",
        "process must be boolean.",
        `${path}.process`,
      ),
    );
  }
  if (
    value.executionBoundary !== "isolated" &&
    value.executionBoundary !== "shared-user"
  ) {
    diagnostics.push(
      error(
        "access-receipt.boundary",
        "executionBoundary must be isolated or shared-user.",
        `${path}.executionBoundary`,
      ),
    );
  }
  validateAccessCapabilities(value.enforcement, `${path}.enforcement`, diagnostics);

  if (!Array.isArray(value.mounts)) {
    diagnostics.push(
      error(
        "access-receipt.mounts",
        "mounts must be an array.",
        `${path}.mounts`,
      ),
    );
  } else {
    const workspaceHandles = new Set<string>();
    const mountIds = new Set<string>();
    value.mounts.forEach((mount, index) => {
      const mountPath = `${path}.mounts[${index}]`;
      if (!isRecord(mount)) {
        diagnostics.push(
          error("access-receipt.mount", "Mount must be an object.", mountPath),
        );
        return;
      }
      validateOpaqueId(
        mount.workspaceHandle,
        `${mountPath}.workspaceHandle`,
        diagnostics,
      );
      validateOpaqueId(mount.mountId, `${mountPath}.mountId`, diagnostics);
      if (typeof mount.workspaceHandle === "string") {
        if (workspaceHandles.has(mount.workspaceHandle)) {
          diagnostics.push(
            error(
              "access-receipt.workspace-duplicate",
              `Duplicate workspace mapping: ${mount.workspaceHandle}.`,
              `${mountPath}.workspaceHandle`,
            ),
          );
        }
        workspaceHandles.add(mount.workspaceHandle);
      }
      if (typeof mount.mountId === "string") {
        if (mountIds.has(mount.mountId)) {
          diagnostics.push(
            error(
              "access-receipt.mount-duplicate",
              `Duplicate mount id: ${mount.mountId}.`,
              `${mountPath}.mountId`,
            ),
          );
        }
        mountIds.add(mount.mountId);
      }
      if (mount.mode !== "read-only" && mount.mode !== "read-write") {
        diagnostics.push(
          error(
            "access-receipt.mount-mode",
            "Mount mode must be read-only or read-write.",
            `${mountPath}.mode`,
          ),
        );
      }
    });

    if (value.workingDirectory !== undefined) {
      if (!isRecord(value.workingDirectory)) {
        diagnostics.push(
          error(
            "access-receipt.cwd",
            "workingDirectory must be an object.",
            `${path}.workingDirectory`,
          ),
        );
      } else {
        validateOpaqueId(
          value.workingDirectory.mountId,
          `${path}.workingDirectory.mountId`,
          diagnostics,
        );
        if (
          typeof value.workingDirectory.mountId === "string" &&
          !mountIds.has(value.workingDirectory.mountId)
        ) {
          diagnostics.push(
            error(
              "access-receipt.cwd-mount",
              "workingDirectory must reference a receipt mount.",
              `${path}.workingDirectory.mountId`,
            ),
          );
        }
        if (!isSafeRelativePath(value.workingDirectory.path, true)) {
          diagnostics.push(
            error(
              "access-receipt.cwd-path",
              "workingDirectory.path must be a normalized relative POSIX path.",
              `${path}.workingDirectory.path`,
            ),
          );
        }
      }
    }
  }

  return diagnostics;
}

export function validateLimitReceipt(
  value: unknown,
  path = "limits",
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  if (!isRecord(value)) {
    return [error("limit-receipt.type", "Limit receipt must be an object.", path)];
  }
  for (const [name, enforced] of Object.entries(value)) {
    if (!LIMIT_NAMES.includes(name as LimitName)) {
      diagnostics.push(
        error(
          "limit-receipt.unknown",
          `Unknown enforced limit: ${name}.`,
          `${path}.${name}`,
        ),
      );
      continue;
    }
    if (
      !isRecord(enforced) ||
      !isPositiveInteger(enforced.value) ||
      !["backend-hard", "host-abort", "best-effort"].includes(
        String(enforced.enforcement),
      )
    ) {
      diagnostics.push(
        error(
          "limit-receipt.value",
          "An enforced limit requires a positive integer value and supported enforcement.",
          `${path}.${name}`,
        ),
      );
    }
  }
  return diagnostics;
}

export function validateAccessEnforcement(
  request: AccessRequest,
  receipt: AccessReceipt,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  if (receipt.level !== request.level) {
    diagnostics.push(
      error(
        "preflight.access-level",
        "Access receipt level does not match the request.",
        "access.level",
      ),
    );
  }
  if (receipt.network !== request.network) {
    diagnostics.push(
      error(
        "preflight.network",
        "Access receipt network policy does not match the request.",
        "access.network",
      ),
    );
  }
  if (receipt.executionBoundary !== request.executionBoundary) {
    diagnostics.push(
      error(
        "preflight.execution-boundary",
        "Access receipt execution boundary does not match the request.",
        "access.executionBoundary",
      ),
    );
  }
  if (receipt.process !== (request.allowProcess === true)) {
    diagnostics.push(
      error(
        "preflight.process",
        "Access receipt process policy does not match the request.",
        "access.process",
      ),
    );
  }

  if (
    receipt.executionBoundary === "isolated" &&
    request.level === "read-only" &&
    (!receipt.enforcement.readOnlyMountIsolation ||
      !receipt.enforcement.symlinkSafeContainment)
  ) {
    diagnostics.push(
      error(
        "preflight.read-isolation",
        "Isolated read-only access requires mount isolation and symlink-safe containment.",
        "access.enforcement",
      ),
    );
  }
  if (
    request.level === "workspace-write" &&
    (!receipt.enforcement.readWriteMountIsolation ||
      !receipt.enforcement.symlinkSafeContainment)
  ) {
    diagnostics.push(
      error(
        "preflight.write-isolation",
        "workspace-write requires write isolation and symlink-safe containment.",
        "access.enforcement",
      ),
    );
  }
  if (request.allowProcess && !receipt.enforcement.processIsolation) {
    diagnostics.push(
      error(
        "preflight.process-isolation",
        "Process access requires process isolation.",
        "access.enforcement.processIsolation",
      ),
    );
  }
  if (
    request.network === "deny" &&
    !receipt.enforcement.agentNetworkIsolation
  ) {
    diagnostics.push(
      error(
        "preflight.network-isolation",
        "Denied agent network requires network isolation.",
        "access.enforcement.agentNetworkIsolation",
      ),
    );
  }

  const mapped = new Map(
    receipt.mounts.map((mount) => [mount.workspaceHandle, mount]),
  );
  for (const workspace of request.workspaces) {
    const mount = mapped.get(workspace.handle);
    if (!mount) {
      diagnostics.push(
        error(
          "preflight.mount-missing",
          `Missing mount mapping for ${workspace.handle}.`,
          "access.mounts",
        ),
      );
    } else if (mount.mode !== workspace.mode) {
      diagnostics.push(
        error(
          "preflight.mount-mode",
          `Mount mode mismatch for ${workspace.handle}.`,
          "access.mounts",
        ),
      );
    }
  }
  for (const mount of receipt.mounts) {
    if (
      !request.workspaces.some(
        (workspace) => workspace.handle === mount.workspaceHandle,
      )
    ) {
      diagnostics.push(
        error(
          "preflight.mount-extra",
          `Unexpected mount mapping for ${mount.workspaceHandle}.`,
          "access.mounts",
        ),
      );
    }
  }

  if (request.workingDirectory) {
    const requestedMount = mapped.get(
      request.workingDirectory.workspaceHandle,
    );
    if (
      !receipt.workingDirectory ||
      receipt.workingDirectory.mountId !== requestedMount?.mountId ||
      receipt.workingDirectory.path !== request.workingDirectory.path
    ) {
      diagnostics.push(
        error(
          "preflight.cwd",
          "Working-directory receipt does not match the request.",
          "access.workingDirectory",
        ),
      );
    }
  } else if (receipt.workingDirectory) {
    diagnostics.push(
      error(
        "preflight.cwd-extra",
        "Backend produced an unrequested working directory.",
        "access.workingDirectory",
      ),
    );
  }
  return diagnostics;
}

export function validateLimitEnforcement(
  request: LimitRequest,
  receipt: LimitReceipt,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const name of LIMIT_NAMES) {
    const requirement = request[name];
    if (!isRecord(requirement)) continue;
    const enforced = receipt[name];
    if (!enforced) {
      diagnostics.push(
        error(
          "preflight.limit-missing",
          `Backend did not accept required limit ${name}.`,
          `limits.${name}`,
        ),
      );
      continue;
    }
    if (enforced.value !== requirement.value) {
      diagnostics.push(
        error(
          "preflight.limit-value",
          `Accepted ${name} value does not match the request.`,
          `limits.${name}.value`,
        ),
      );
    }
    if (
      requirement.enforcement === "required" &&
      enforced.enforcement !== "backend-hard"
    ) {
      diagnostics.push(
        error(
          "preflight.limit-enforcement",
          `Required ${name} must be backend-hard.`,
          `limits.${name}.enforcement`,
        ),
      );
    }
  }
  for (const name of LIMIT_NAMES) {
    if (receipt[name] && request[name] === undefined) {
      diagnostics.push(
        error(
          "preflight.limit-extra",
          `Backend accepted unrequested limit ${name}.`,
          `limits.${name}`,
        ),
      );
    }
  }
  return diagnostics;
}

export function validateSealedPlanSnapshot(value: unknown): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  if (!isRecord(value)) {
    return [error("plan.type", "Sealed plan must be an object.", "$")];
  }
  if (value.schemaVersion !== EXECUTION_CONTRACT_VERSION) {
    diagnostics.push(
      error(
        "plan.schema-version",
        `schemaVersion must be ${EXECUTION_CONTRACT_VERSION}.`,
        "schemaVersion",
      ),
    );
  }
  validateOpaqueId(value.preparedRunId, "preparedRunId", diagnostics);
  validateOpaqueId(value.backendId, "backendId", diagnostics);
  validateOpaqueId(value.preflightId, "preflightId", diagnostics);
  const intentDiagnostics = validateExecutionIntent(value.intent);
  diagnostics.push(...intentDiagnostics);
  diagnostics.push(
    ...validateBackendPreflight(
      value.preflight,
      isRecord(value.intent) && !hasErrors(intentDiagnostics)
        ? (value.intent as unknown as ExecutionIntent)
        : undefined,
    ),
  );
  validatePromptRuntimeAt(value.promptRuntime, "promptRuntime", diagnostics);
  validatePreparedConversationAt(
    value.conversation,
    "conversation",
    diagnostics,
  );
  validateEffectiveTools(value.effectiveTools, diagnostics);
  validatePlanToolBindings(value, diagnostics);
  validatePlanMediaBindings(value, diagnostics);
  validateFingerprint(
    value.conversationFingerprint,
    "conversationFingerprint",
    diagnostics,
  );
  validateFingerprint(
    value.executionFingerprint,
    "executionFingerprint",
    diagnostics,
  );

  if (isRecord(value.preflight)) {
    if (
      isRecord(value.preflight.backend) &&
      value.preflight.backend.id !== value.backendId
    ) {
      diagnostics.push(
        error(
          "plan.backend-binding",
          "Plan backendId does not match preflight backend.",
          "backendId",
        ),
      );
    }
    if (value.preflight.preflightId !== value.preflightId) {
      diagnostics.push(
        error(
          "plan.preflight-binding",
          "Plan preflightId does not match the accepted preflight.",
          "preflightId",
        ),
      );
    }
  }

  if (
    isRecord(value.promptRuntime) &&
    isRecord(value.preflight) &&
    isRecord(value.preflight.model) &&
    isRecord(value.promptRuntime.model) &&
    (value.promptRuntime.model.provider !== value.preflight.model.provider ||
      value.promptRuntime.model.id !== value.preflight.model.id)
  ) {
    diagnostics.push(
      error(
        "plan.runtime-model",
        "Prompt runtime model does not match preflight model.",
        "promptRuntime.model",
      ),
    );
  }
  if (
    isRecord(value.promptRuntime) &&
    isRecord(value.preflight) &&
    isRecord(value.preflight.backend) &&
    isRecord(value.preflight.backend.capabilities) &&
    value.promptRuntime.fidelity !==
      value.preflight.backend.capabilities.promptRuntimeFidelity
  ) {
    diagnostics.push(
      error(
        "plan.runtime-fidelity",
        "Prompt runtime fidelity does not match the accepted backend.",
        "promptRuntime.fidelity",
      ),
    );
  }
  if (
    isRecord(value.preflight) &&
    isRecord(value.preflight.backend) &&
    isRecord(value.preflight.backend.capabilities) &&
    value.preflight.backend.capabilities.promptRuntimeFidelity ===
      "exact-preflight" &&
    value.preflight.promptRuntime !== undefined &&
    isRecord(value.promptRuntime) &&
    !canonicalValuesEqual(value.promptRuntime, value.preflight.promptRuntime)
  ) {
    diagnostics.push(
      error(
        "plan.runtime-binding",
        "Plan prompt runtime differs from the exact preflight runtime.",
        "promptRuntime",
      ),
    );
  }

  if (
    isRecord(value.conversation) &&
    Array.isArray(value.conversation.messages) &&
    isFingerprint(value.conversationFingerprint)
  ) {
    try {
      const actual = conversationFingerprint(
        value.conversation as unknown as PreparedConversation,
      );
      if (value.conversationFingerprint !== actual) {
        diagnostics.push(
          error(
            "plan.conversation-fingerprint",
            "conversationFingerprint does not match the prepared conversation.",
            "conversationFingerprint",
          ),
        );
      }
    } catch {
      diagnostics.push(
        error(
          "plan.conversation-canonical",
          "Prepared conversation contains a non-canonical value.",
          "conversation",
        ),
      );
    }
  }

  if (isFingerprint(value.executionFingerprint)) {
    try {
      const actual = executionFingerprint(
        value as unknown as SealedPlanSnapshot,
      );
      if (value.executionFingerprint !== actual) {
        diagnostics.push(
          error(
            "plan.execution-fingerprint",
            "executionFingerprint does not match the sealed plan.",
            "executionFingerprint",
          ),
        );
      }
    } catch {
      diagnostics.push(
        error(
          "plan.execution-canonical",
          "Sealed plan contains a non-canonical value.",
          "$",
        ),
      );
    }
  }

  return diagnostics;
}

export function validateRunResult(
  value: unknown,
  plan?: SealedPlanSnapshot,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  if (!isRecord(value)) {
    return [error("result.type", "Run result must be an object.", "$")];
  }
  if (value.schemaVersion !== EXECUTION_CONTRACT_VERSION) {
    diagnostics.push(
      error(
        "result.schema-version",
        `schemaVersion must be ${EXECUTION_CONTRACT_VERSION}.`,
        "schemaVersion",
      ),
    );
  }
  for (const field of ["runId", "preparedRunId", "backendId"] as const) {
    validateOpaqueId(value[field], field, diagnostics);
  }
  validateFingerprint(
    value.conversationFingerprint,
    "conversationFingerprint",
    diagnostics,
  );
  validateFingerprint(
    value.executionFingerprint,
    "executionFingerprint",
    diagnostics,
  );
  validateModelReference(value.model, "model", diagnostics);
  validateUniqueNonEmptyStrings(
    value.effectiveToolIds,
    "effectiveToolIds",
    diagnostics,
  );
  if (!isRecord(value.enforcement)) {
    diagnostics.push(
      error(
        "result.enforcement",
        "enforcement must be an object.",
        "enforcement",
      ),
    );
  } else {
    diagnostics.push(
      ...validateAccessReceipt(value.enforcement.access, "enforcement.access"),
      ...validateLimitReceipt(value.enforcement.limits, "enforcement.limits"),
    );
  }
  if (!isNonNegativeFinite(value.durationMs)) {
    diagnostics.push(
      error(
        "result.duration",
        "durationMs must be a non-negative finite number.",
        "durationMs",
      ),
    );
  }
  if (value.usage !== undefined) {
    validateUsage(value.usage, "usage", diagnostics);
  }

  switch (value.status) {
    case "completed":
      validateOutput(value.output, "output", diagnostics, true);
      break;
    case "failed":
      validateRunError(value.error, "error", diagnostics);
      if (value.output !== undefined) {
        validateOutput(value.output, "output", diagnostics, false);
      }
      break;
    case "cancelled":
      validateReason(value.reason, "reason", diagnostics);
      if (value.output !== undefined) {
        validateOutput(value.output, "output", diagnostics, false);
      }
      break;
    case "timed-out":
      validateReason(value.reason, "reason", diagnostics);
      if (!isPositiveInteger(value.enforcedTimeoutMs)) {
        diagnostics.push(
          error(
            "result.timeout",
            "enforcedTimeoutMs must be a positive integer.",
            "enforcedTimeoutMs",
          ),
        );
      }
      if (value.output !== undefined) {
        validateOutput(value.output, "output", diagnostics, false);
      }
      break;
    case "limit-reached":
      if (
        !["maxTurns", "tokenBudget", "maxOutputBytes"].includes(
          String(value.reachedLimit),
        )
      ) {
        diagnostics.push(
          error(
            "result.reached-limit",
            "reachedLimit must name a non-timeout limit.",
            "reachedLimit",
          ),
        );
      }
      if (value.output !== undefined) {
        validateOutput(value.output, "output", diagnostics, false);
      }
      break;
    default:
      diagnostics.push(
        error("result.status", "Unsupported terminal result status.", "status"),
      );
  }

  if (plan) {
    if (value.preparedRunId !== plan.preparedRunId) {
      diagnostics.push(
        error(
          "result.prepared-run-binding",
          "Result preparedRunId does not match the plan.",
          "preparedRunId",
        ),
      );
    }
    if (value.backendId !== plan.backendId) {
      diagnostics.push(
        error(
          "result.backend-binding",
          "Result backendId does not match the plan.",
          "backendId",
        ),
      );
    }
    if (value.conversationFingerprint !== plan.conversationFingerprint) {
      diagnostics.push(
        error(
          "result.conversation-binding",
          "Result conversation fingerprint does not match the plan.",
          "conversationFingerprint",
        ),
      );
    }
    if (value.executionFingerprint !== plan.executionFingerprint) {
      diagnostics.push(
        error(
          "result.execution-binding",
          "Result execution fingerprint does not match the plan.",
          "executionFingerprint",
        ),
      );
    }
    if (
      isRecord(value.model) &&
      !canonicalValuesEqual(value.model, plan.preflight.model)
    ) {
      diagnostics.push(
        error(
          "result.model-binding",
          "Result model does not match the accepted plan model.",
          "model",
        ),
      );
    }
    if (
      Array.isArray(value.effectiveToolIds) &&
      !canonicalValuesEqual(
        value.effectiveToolIds,
        plan.effectiveTools.map((tool) => tool.backendToolId),
      )
    ) {
      diagnostics.push(
        error(
          "result.tool-binding",
          "Result effective tools do not match the plan.",
          "effectiveToolIds",
        ),
      );
    }
    if (
      isRecord(value.enforcement) &&
      (!canonicalValuesEqual(
        value.enforcement.access,
        plan.preflight.access,
      ) ||
        !canonicalValuesEqual(
          value.enforcement.limits,
          plan.preflight.limits,
        ))
    ) {
      diagnostics.push(
        error(
          "result.enforcement-binding",
          "Result enforcement receipt does not match the accepted plan.",
          "enforcement",
        ),
      );
    }
  }

  return diagnostics;
}

export function hasErrors(diagnostics: readonly Diagnostic[]): boolean {
  return diagnostics.some((diagnostic) => diagnostic.level === "error");
}

export function error(
  code: string,
  message: string,
  path?: string,
): Diagnostic {
  return path === undefined
    ? { level: "error", code, message }
    : { level: "error", code, message, path };
}

export function isFingerprint(value: unknown): value is Fingerprint {
  return (
    typeof value === "string" &&
    value.startsWith(FINGERPRINT_PREFIX) &&
    FINGERPRINT_PATTERN.test(value)
  );
}

export function isRecord(
  value: unknown,
): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function isSafeRelativePath(
  value: unknown,
  allowDot = false,
): boolean {
  if (
    typeof value !== "string" ||
    value.includes("\\") ||
    value.startsWith("/") ||
    value.includes("\0")
  ) {
    return false;
  }
  if (allowDot && value === ".") return true;
  if (!value) return false;
  const segments = value.split("/");
  return segments.every(
    (segment) => segment.length > 0 && segment !== "." && segment !== "..",
  );
}

function validateBackendDescriptorAt(
  value: unknown,
  path: string,
  diagnostics: Diagnostic[],
): void {
  if (!isRecord(value)) {
    diagnostics.push(
      error("backend.type", "Backend descriptor must be an object.", path),
    );
    return;
  }
  validateOpaqueId(value.id, `${path}.id`, diagnostics);
  if (
    typeof value.version !== "string" ||
    !value.version.trim() ||
    value.version.length > 128
  ) {
    diagnostics.push(
      error(
        "backend.version",
        "Backend version must be a non-empty string of at most 128 characters.",
        `${path}.version`,
      ),
    );
  }
  if (!isRecord(value.capabilities)) {
    diagnostics.push(
      error(
        "backend.capabilities",
        "capabilities must be an object.",
        `${path}.capabilities`,
      ),
    );
    return;
  }

  const capabilities = value.capabilities;
  validateAccessCapabilities(
    capabilities.access,
    `${path}.capabilities.access`,
    diagnostics,
  );
  if (
    !Array.isArray(capabilities.executionBoundaries) ||
    capabilities.executionBoundaries.length === 0
  ) {
    diagnostics.push(
      error(
        "backend.execution-boundaries",
        "executionBoundaries must advertise at least one boundary.",
        `${path}.capabilities.executionBoundaries`,
      ),
    );
  } else {
    const boundaries = new Set<string>();
    capabilities.executionBoundaries.forEach((boundary, index) => {
      if (boundary !== "isolated" && boundary !== "shared-user") {
        diagnostics.push(
          error(
            "backend.execution-boundary",
            `Unsupported execution boundary: ${String(boundary)}.`,
            `${path}.capabilities.executionBoundaries[${index}]`,
          ),
        );
      } else if (boundaries.has(boundary)) {
        diagnostics.push(
          error(
            "backend.execution-boundary-duplicate",
            `Duplicate execution boundary: ${boundary}.`,
            `${path}.capabilities.executionBoundaries[${index}]`,
          ),
        );
      }
      boundaries.add(String(boundary));
    });
  }
  if (!isRecord(capabilities.limits)) {
    diagnostics.push(
      error(
        "backend.limits",
        "limits capabilities must be an object.",
        `${path}.capabilities.limits`,
      ),
    );
  } else {
    for (const name of LIMIT_NAMES) {
      const supported = capabilities.limits[name];
      const limitPath = `${path}.capabilities.limits.${name}`;
      if (!Array.isArray(supported) || supported.length === 0) {
        diagnostics.push(
          error(
            "backend.limit-capability",
            `${name} must advertise at least one enforcement value.`,
            limitPath,
          ),
        );
        continue;
      }
      const seen = new Set<string>();
      for (const [index, item] of supported.entries()) {
        if (!LIMIT_ENFORCEMENTS.includes(item as LimitEnforcement)) {
          diagnostics.push(
            error(
              "backend.limit-enforcement",
              `Unsupported limit enforcement: ${String(item)}.`,
              `${limitPath}[${index}]`,
            ),
          );
        } else if (seen.has(String(item))) {
          diagnostics.push(
            error(
              "backend.limit-duplicate",
              `Duplicate limit enforcement: ${String(item)}.`,
              `${limitPath}[${index}]`,
            ),
          );
        }
        seen.add(String(item));
      }
      if (seen.has("unsupported") && seen.size > 1) {
        diagnostics.push(
          error(
            "backend.limit-unsupported",
            "unsupported cannot be combined with supported enforcement values.",
            limitPath,
          ),
        );
      }
    }
  }
  if (typeof capabilities.cancellation !== "boolean") {
    diagnostics.push(
      error(
        "backend.cancellation",
        "cancellation must be boolean.",
        `${path}.capabilities.cancellation`,
      ),
    );
  }
  validateUniqueNonEmptyStrings(
    capabilities.mediaMimeTypes,
    `${path}.capabilities.mediaMimeTypes`,
    diagnostics,
  );
  if (Array.isArray(capabilities.mediaMimeTypes)) {
    capabilities.mediaMimeTypes.forEach((mime, index) => {
      if (
        typeof mime === "string" &&
        !/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(mime)
      ) {
        diagnostics.push(
          error(
            "backend.media-mime",
            "mediaMimeTypes entries must be MIME types.",
            `${path}.capabilities.mediaMimeTypes[${index}]`,
          ),
        );
      }
    });
  }
  if (typeof capabilities.remoteTransport !== "boolean") {
    diagnostics.push(
      error(
        "backend.remote-transport",
        "remoteTransport must be boolean.",
        `${path}.capabilities.remoteTransport`,
      ),
    );
  }
  if (
    !["exact-preflight", "backend-assisted", "partial"].includes(
      String(capabilities.promptRuntimeFidelity),
    )
  ) {
    diagnostics.push(
      error(
        "backend.prompt-fidelity",
        "Unsupported prompt-runtime fidelity.",
        `${path}.capabilities.promptRuntimeFidelity`,
      ),
    );
  }
}

function validatePromptRuntimeAt(
  value: unknown,
  path: string,
  diagnostics: Diagnostic[],
  expectedFidelity?: PromptRuntime["fidelity"],
): void {
  if (!isRecord(value)) {
    diagnostics.push(
      error("prompt-runtime.type", "Prompt runtime must be an object.", path),
    );
    return;
  }
  if (typeof value.baseSystemPrompt !== "string") {
    diagnostics.push(
      error(
        "prompt-runtime.base-system",
        "baseSystemPrompt must be a string.",
        `${path}.baseSystemPrompt`,
      ),
    );
  }
  validateModelReference(value.model, `${path}.model`, diagnostics);
  if (!isIsoDate(value.preparedAt)) {
    diagnostics.push(
      error(
        "prompt-runtime.prepared-at",
        "preparedAt must be an ISO timestamp.",
        `${path}.preparedAt`,
      ),
    );
  }
  if (
    value.fidelity !== "exact-preflight" &&
    value.fidelity !== "backend-assisted"
  ) {
    diagnostics.push(
      error(
        "prompt-runtime.fidelity",
        "Prompt runtime fidelity must be exact-preflight or backend-assisted.",
        `${path}.fidelity`,
      ),
    );
  } else if (expectedFidelity && value.fidelity !== expectedFidelity) {
    diagnostics.push(
      error(
        "prompt-runtime.expected-fidelity",
        `Prompt runtime fidelity must be ${expectedFidelity}.`,
        `${path}.fidelity`,
      ),
    );
  }

  if (!isRecord(value.options)) {
    diagnostics.push(
      error(
        "prompt-runtime.options",
        "options must be an object.",
        `${path}.options`,
      ),
    );
  } else {
    const options = value.options;
    if (
      options.customPrompt !== undefined &&
      typeof options.customPrompt !== "string"
    ) {
      diagnostics.push(
        error(
          "prompt-runtime.custom-prompt",
          "customPrompt must be a string.",
          `${path}.options.customPrompt`,
        ),
      );
    }
    validateUniqueNonEmptyStrings(
      options.selectedTools,
      `${path}.options.selectedTools`,
      diagnostics,
    );
    if (!isRecord(options.toolSnippets)) {
      diagnostics.push(
        error(
          "prompt-runtime.tool-snippets",
          "toolSnippets must be a string record.",
          `${path}.options.toolSnippets`,
        ),
      );
    } else {
      for (const [name, snippet] of Object.entries(options.toolSnippets)) {
        if (!name || typeof snippet !== "string") {
          diagnostics.push(
            error(
              "prompt-runtime.tool-snippet",
              "Tool snippet keys must be non-empty and values must be strings.",
              `${path}.options.toolSnippets.${name}`,
            ),
          );
        }
      }
    }
    validateStringArray(
      options.promptGuidelines,
      `${path}.options.promptGuidelines`,
      diagnostics,
    );
    if (
      options.appendSystemPrompt !== undefined &&
      typeof options.appendSystemPrompt !== "string"
    ) {
      diagnostics.push(
        error(
          "prompt-runtime.append-system",
          "appendSystemPrompt must be a string.",
          `${path}.options.appendSystemPrompt`,
        ),
      );
    }
    if (typeof options.cwd !== "string" || !options.cwd) {
      diagnostics.push(
        error(
          "prompt-runtime.cwd",
          "cwd must be a non-empty string.",
          `${path}.options.cwd`,
        ),
      );
    }
    if (!Array.isArray(options.contextFiles)) {
      diagnostics.push(
        error(
          "prompt-runtime.context-files",
          "contextFiles must be an array.",
          `${path}.options.contextFiles`,
        ),
      );
    } else {
      options.contextFiles.forEach((file, index) => {
        if (
          !isRecord(file) ||
          typeof file.path !== "string" ||
          !file.path ||
          typeof file.content !== "string"
        ) {
          diagnostics.push(
            error(
              "prompt-runtime.context-file",
              "Each context file requires path and content strings.",
              `${path}.options.contextFiles[${index}]`,
            ),
          );
        }
      });
    }
    if (!Array.isArray(options.skills)) {
      diagnostics.push(
        error(
          "prompt-runtime.skills",
          "skills must be an array.",
          `${path}.options.skills`,
        ),
      );
    } else {
      options.skills.forEach((skill, index) => {
        const skillPath = `${path}.options.skills[${index}]`;
        if (!isRecord(skill)) {
          diagnostics.push(
            error(
              "prompt-runtime.skill",
              "Skill must be an object.",
              skillPath,
            ),
          );
          return;
        }
        for (const field of ["name", "description", "filePath"] as const) {
          if (typeof skill[field] !== "string") {
            diagnostics.push(
              error(
                "prompt-runtime.skill-field",
                `${field} must be a string.`,
                `${skillPath}.${field}`,
              ),
            );
          }
        }
        if (typeof skill.disableModelInvocation !== "boolean") {
          diagnostics.push(
            error(
              "prompt-runtime.skill-invocation",
              "disableModelInvocation must be boolean.",
              `${skillPath}.disableModelInvocation`,
            ),
          );
        }
      });
    }
  }

  validateFingerprint(
    value.promptRuntimeFingerprint,
    `${path}.promptRuntimeFingerprint`,
    diagnostics,
  );
  if (isFingerprint(value.promptRuntimeFingerprint)) {
    try {
      const actual = promptRuntimeFingerprint(value as unknown as PromptRuntime);
      if (value.promptRuntimeFingerprint !== actual) {
        diagnostics.push(
          error(
            "prompt-runtime.fingerprint-mismatch",
            "promptRuntimeFingerprint does not match the runtime.",
            `${path}.promptRuntimeFingerprint`,
          ),
        );
      }
    } catch {
      diagnostics.push(
        error(
          "prompt-runtime.canonical",
          "Prompt runtime contains a non-canonical value.",
          path,
        ),
      );
    }
  }
}

function validatePreparedConversationAt(
  value: unknown,
  path: string,
  diagnostics: Diagnostic[],
): void {
  if (!isRecord(value)) {
    diagnostics.push(
      error(
        "conversation.type",
        "Prepared conversation must be an object.",
        path,
      ),
    );
    return;
  }
  if (typeof value.systemPrompt !== "string") {
    diagnostics.push(
      error(
        "conversation.system-prompt",
        "systemPrompt must be a string.",
        `${path}.systemPrompt`,
      ),
    );
  }
  if (!Array.isArray(value.messages) || value.messages.length === 0) {
    diagnostics.push(
      error(
        "conversation.messages",
        "messages must be a non-empty array.",
        `${path}.messages`,
      ),
    );
    return;
  }
  value.messages.forEach((message, index) => {
    const messagePath = `${path}.messages[${index}]`;
    if (!isRecord(message)) {
      diagnostics.push(
        error(
          "conversation.message",
          "Prepared message must be an object.",
          messagePath,
        ),
      );
      return;
    }
    if (!["user", "assistant", "custom"].includes(String(message.role))) {
      diagnostics.push(
        error(
          "conversation.message-role",
          "Unsupported prepared message role.",
          `${messagePath}.role`,
        ),
      );
    }
    if (!Array.isArray(message.content) || message.content.length === 0) {
      diagnostics.push(
        error(
          "conversation.message-content",
          "Message content must be a non-empty array.",
          `${messagePath}.content`,
        ),
      );
      return;
    }
    message.content.forEach((part, partIndex) => {
      const partPath = `${messagePath}.content[${partIndex}]`;
      if (!isRecord(part)) {
        diagnostics.push(
          error(
            "conversation.content-part",
            "Content part must be an object.",
            partPath,
          ),
        );
      } else if (part.type === "text") {
        if (typeof part.text !== "string") {
          diagnostics.push(
            error(
              "conversation.text",
              "Text content requires a text string.",
              `${partPath}.text`,
            ),
          );
        }
      } else if (part.type === "media") {
        validateOpaqueId(part.mediaId, `${partPath}.mediaId`, diagnostics);
        if (
          typeof part.mimeType !== "string" ||
          !part.mimeType.includes("/")
        ) {
          diagnostics.push(
            error(
              "conversation.media-mime",
              "Media content requires a MIME type.",
              `${partPath}.mimeType`,
            ),
          );
        }
        validateFingerprint(part.digest, `${partPath}.digest`, diagnostics);
        if (part.backendResourceId !== undefined) {
          validateOpaqueId(
            part.backendResourceId,
            `${partPath}.backendResourceId`,
            diagnostics,
          );
        }
      } else {
        diagnostics.push(
          error(
            "conversation.content-type",
            "Unsupported prepared content part type.",
            `${partPath}.type`,
          ),
        );
      }
    });
  });
}

function validateToolCatalog(
  value: unknown,
  path: string,
  diagnostics: Diagnostic[],
): void {
  if (!Array.isArray(value)) {
    diagnostics.push(
      error("tool-catalog.type", "toolCatalog must be an array.", path),
    );
    return;
  }
  const ids = new Set<string>();
  const names = new Set<string>();
  value.forEach((tool, index) => {
    const toolPath = `${path}[${index}]`;
    if (!isRecord(tool)) {
      diagnostics.push(
        error("tool-catalog.tool", "Tool must be an object.", toolPath),
      );
      return;
    }
    validateOpaqueId(tool.id, `${toolPath}.id`, diagnostics);
    if (typeof tool.name !== "string" || !tool.name.trim()) {
      diagnostics.push(
        error(
          "tool-catalog.name",
          "Tool name must be a non-empty string.",
          `${toolPath}.name`,
        ),
      );
    }
    if (typeof tool.id === "string") {
      if (ids.has(tool.id)) {
        diagnostics.push(
          error(
            "tool-catalog.id-duplicate",
            `Duplicate tool id: ${tool.id}.`,
            `${toolPath}.id`,
          ),
        );
      }
      ids.add(tool.id);
    }
    if (typeof tool.name === "string") {
      if (names.has(tool.name)) {
        diagnostics.push(
          error(
            "tool-catalog.name-duplicate",
            `Duplicate tool name: ${tool.name}.`,
            `${toolPath}.name`,
          ),
        );
      }
      names.add(tool.name);
    }
    if (
      tool.description !== undefined &&
      typeof tool.description !== "string"
    ) {
      diagnostics.push(
        error(
          "tool-catalog.description",
          "Tool description must be a string.",
          `${toolPath}.description`,
        ),
      );
    }
    if (
      tool.promptSnippet !== undefined &&
      typeof tool.promptSnippet !== "string"
    ) {
      diagnostics.push(
        error(
          "tool-catalog.prompt-snippet",
          "Tool promptSnippet must be a string.",
          `${toolPath}.promptSnippet`,
        ),
      );
    }
    if (!Array.isArray(tool.effects)) {
      diagnostics.push(
        error(
          "tool-catalog.effects",
          "Tool effects must be an array.",
          `${toolPath}.effects`,
        ),
      );
    } else {
      const effects = new Set<string>();
      tool.effects.forEach((effect, effectIndex) => {
        if (!TOOL_EFFECTS.includes(effect as ToolEffect)) {
          diagnostics.push(
            error(
              "tool-catalog.effect",
              `Unsupported tool effect: ${String(effect)}.`,
              `${toolPath}.effects[${effectIndex}]`,
            ),
          );
        } else if (effects.has(String(effect))) {
          diagnostics.push(
            error(
              "tool-catalog.effect-duplicate",
              `Duplicate tool effect: ${String(effect)}.`,
              `${toolPath}.effects[${effectIndex}]`,
            ),
          );
        }
        effects.add(String(effect));
      });
    }
  });
}

function validateEffectiveTools(
  value: unknown,
  diagnostics: Diagnostic[],
): void {
  if (!Array.isArray(value)) {
    diagnostics.push(
      error(
        "plan.effective-tools",
        "effectiveTools must be an array.",
        "effectiveTools",
      ),
    );
    return;
  }
  const requested = new Set<string>();
  const ids = new Set<string>();
  value.forEach((mapping, index) => {
    const path = `effectiveTools[${index}]`;
    if (!isRecord(mapping)) {
      diagnostics.push(
        error(
          "plan.effective-tool",
          "Effective tool mapping must be an object.",
          path,
        ),
      );
      return;
    }
    for (const field of [
      "requestedName",
      "backendToolId",
      "backendToolName",
    ] as const) {
      if (typeof mapping[field] !== "string" || !mapping[field].trim()) {
        diagnostics.push(
          error(
            "plan.effective-tool-field",
            `${field} must be a non-empty string.`,
            `${path}.${field}`,
          ),
        );
      }
    }
    if (typeof mapping.requestedName === "string") {
      if (requested.has(mapping.requestedName)) {
        diagnostics.push(
          error(
            "plan.effective-tool-request-duplicate",
            `Duplicate requested tool mapping: ${mapping.requestedName}.`,
            `${path}.requestedName`,
          ),
        );
      }
      requested.add(mapping.requestedName);
    }
    if (typeof mapping.backendToolId === "string") {
      if (ids.has(mapping.backendToolId)) {
        diagnostics.push(
          error(
            "plan.effective-tool-id-duplicate",
            `Duplicate backend tool mapping: ${mapping.backendToolId}.`,
            `${path}.backendToolId`,
          ),
        );
      }
      ids.add(mapping.backendToolId);
    }
  });
}

function validatePlanToolBindings(
  value: Record<string, unknown>,
  diagnostics: Diagnostic[],
): void {
  if (
    !isRecord(value.intent) ||
    !Array.isArray(value.intent.requestedTools) ||
    !isRecord(value.preflight) ||
    !Array.isArray(value.preflight.toolCatalog) ||
    !Array.isArray(value.effectiveTools)
  ) {
    return;
  }
  const requestedTools = value.intent.requestedTools;
  const toolCatalog = value.preflight.toolCatalog;
  const effectiveTools = value.effectiveTools;
  if (effectiveTools.length !== requestedTools.length) {
    diagnostics.push(
      error(
        "plan.effective-tool-count",
        "Every requested tool must have exactly one effective mapping.",
        "effectiveTools",
      ),
    );
  }
  const catalogById = new Map<string, Record<string, unknown>>();
  for (const tool of toolCatalog) {
    if (isRecord(tool) && typeof tool.id === "string") {
      catalogById.set(tool.id, tool);
    }
  }
  effectiveTools.forEach((mapping, index) => {
    if (!isRecord(mapping)) return;
    const requestedName = requestedTools[index];
    if (mapping.requestedName !== requestedName) {
      diagnostics.push(
        error(
          "plan.effective-tool-order",
          "Effective tool mappings must follow requested tool order.",
          `effectiveTools[${index}].requestedName`,
        ),
      );
    }
    if (typeof mapping.backendToolId !== "string") return;
    const catalogTool = catalogById.get(mapping.backendToolId);
    if (
      !catalogTool ||
      catalogTool.name !== mapping.backendToolName ||
      catalogTool.name !== mapping.requestedName
    ) {
      diagnostics.push(
        error(
          "plan.effective-tool-binding",
          "Effective tool mapping does not match the accepted tool catalog.",
          `effectiveTools[${index}]`,
        ),
      );
    }
  });
}

function validatePlanMediaBindings(
  value: Record<string, unknown>,
  diagnostics: Diagnostic[],
): void {
  if (
    !isRecord(value.intent) ||
    !isRecord(value.conversation) ||
    !Array.isArray(value.conversation.messages)
  ) {
    return;
  }
  const mediaById = new Map<string, Record<string, unknown>>();
  if (Array.isArray(value.intent.media)) {
    for (const media of value.intent.media) {
      if (isRecord(media) && typeof media.id === "string") {
        mediaById.set(media.id, media);
      }
    }
  }
  value.conversation.messages.forEach((message, messageIndex) => {
    if (!isRecord(message) || !Array.isArray(message.content)) return;
    message.content.forEach((part, partIndex) => {
      if (!isRecord(part) || part.type !== "media") return;
      const media = mediaById.get(String(part.mediaId));
      const path =
        `conversation.messages[${messageIndex}].content[${partIndex}]`;
      if (!media) {
        diagnostics.push(
          error(
            "plan.media-missing",
            "Prepared media content has no matching execution-intent reference.",
            `${path}.mediaId`,
          ),
        );
      } else if (
        part.mimeType !== media.mimeType ||
        part.digest !== media.digest
      ) {
        diagnostics.push(
          error(
            "plan.media-binding",
            "Prepared media MIME type or digest differs from its intent reference.",
            path,
          ),
        );
      }
    });
  });
}

function validateAccessCapabilities(
  value: unknown,
  path: string,
  diagnostics: Diagnostic[],
): void {
  if (!isRecord(value)) {
    diagnostics.push(
      error(
        "access-capabilities.type",
        "Access capabilities must be an object.",
        path,
      ),
    );
    return;
  }
  for (const key of ACCESS_CAPABILITY_KEYS) {
    if (typeof value[key] !== "boolean") {
      diagnostics.push(
        error(
          "access-capabilities.value",
          `${key} must be boolean.`,
          `${path}.${key}`,
        ),
      );
    }
  }
}

function validateMediaReference(
  value: unknown,
  path: string,
  diagnostics: Diagnostic[],
): void {
  if (!isRecord(value)) {
    diagnostics.push(
      error("intent.media-item", "Media reference must be an object.", path),
    );
    return;
  }
  validateOpaqueId(value.id, `${path}.id`, diagnostics);
  if (value.kind !== "image") {
    diagnostics.push(
      error(
        "intent.media-kind",
        "Only image media is supported in v1.",
        `${path}.kind`,
      ),
    );
  }
  if (
    typeof value.mimeType !== "string" ||
    !/^image\/[A-Za-z0-9.+-]+$/.test(value.mimeType)
  ) {
    diagnostics.push(
      error(
        "intent.media-mime",
        "mimeType must be an image MIME type.",
        `${path}.mimeType`,
      ),
    );
  }
  validateFingerprint(value.digest, `${path}.digest`, diagnostics);
  validateOpaqueId(
    value.resourceHandle,
    `${path}.resourceHandle`,
    diagnostics,
  );
}

function validateModelReference(
  value: unknown,
  path: string,
  diagnostics: Diagnostic[],
): void {
  if (
    !isRecord(value) ||
    typeof value.provider !== "string" ||
    !value.provider.trim() ||
    typeof value.id !== "string" ||
    !value.id.trim()
  ) {
    diagnostics.push(
      error(
        "model.reference",
        "Model reference requires non-empty provider and id strings.",
        path,
      ),
    );
  }
}

function validateOpaqueId(
  value: unknown,
  path: string,
  diagnostics: Diagnostic[],
): void {
  if (typeof value !== "string" || !OPAQUE_ID_PATTERN.test(value)) {
    diagnostics.push(
      error(
        "id.invalid",
        "Expected an opaque id using letters, numbers, dot, underscore, colon, or hyphen (max 128).",
        path,
      ),
    );
  }
}

function validateFingerprint(
  value: unknown,
  path: string,
  diagnostics: Diagnostic[],
): void {
  if (!isFingerprint(value)) {
    diagnostics.push(
      error(
        "fingerprint.invalid",
        "Expected sha256:v1 followed by 64 lowercase hex characters.",
        path,
      ),
    );
  }
}

function validateDiagnosticArray(
  value: unknown,
  path: string,
  diagnostics: Diagnostic[],
): void {
  if (!Array.isArray(value)) {
    diagnostics.push(
      error("diagnostic.array", "diagnostics must be an array.", path),
    );
    return;
  }
  value.forEach((item, index) => {
    if (
      !isRecord(item) ||
      !["error", "warning", "info"].includes(String(item.level)) ||
      typeof item.code !== "string" ||
      !item.code ||
      typeof item.message !== "string" ||
      !item.message
    ) {
      diagnostics.push(
        error(
          "diagnostic.invalid",
          "Diagnostic requires a valid level, code, and message.",
          `${path}[${index}]`,
        ),
      );
    } else if (item.path !== undefined && typeof item.path !== "string") {
      diagnostics.push(
        error(
          "diagnostic.path",
          "Diagnostic path must be a string.",
          `${path}[${index}].path`,
        ),
      );
    }
  });
}

function validateUniqueNonEmptyStrings(
  value: unknown,
  path: string,
  diagnostics: Diagnostic[],
): void {
  if (!Array.isArray(value)) {
    diagnostics.push(
      error("array.type", "Expected an array of strings.", path),
    );
    return;
  }
  const seen = new Set<string>();
  value.forEach((item, index) => {
    if (typeof item !== "string" || !item.trim()) {
      diagnostics.push(
        error(
          "array.string",
          "Expected a non-empty string.",
          `${path}[${index}]`,
        ),
      );
    } else if (seen.has(item)) {
      diagnostics.push(
        error(
          "array.duplicate",
          `Duplicate value: ${item}.`,
          `${path}[${index}]`,
        ),
      );
    } else {
      seen.add(item);
    }
  });
}

function validateStringArray(
  value: unknown,
  path: string,
  diagnostics: Diagnostic[],
): void {
  if (!Array.isArray(value)) {
    diagnostics.push(error("array.type", "Expected an array of strings.", path));
    return;
  }
  value.forEach((item, index) => {
    if (typeof item !== "string") {
      diagnostics.push(
        error("array.string", "Expected a string.", `${path}[${index}]`),
      );
    }
  });
}

function accessAllowsEffect(
  access: AccessRequest,
  effect: ToolEffect,
): boolean {
  switch (effect) {
    case "filesystem-read":
      return access.level !== "none";
    case "filesystem-write":
      return access.level === "workspace-write";
    case "process":
      return access.allowProcess === true;
    case "network":
      return access.network === "allow";
  }
}

function validateUsage(
  value: unknown,
  path: string,
  diagnostics: Diagnostic[],
): void {
  if (!isRecord(value)) {
    diagnostics.push(error("usage.type", "usage must be an object.", path));
    return;
  }
  if (value.tokens !== undefined) {
    if (
      !isRecord(value.tokens) ||
      !isNonNegativeInteger(value.tokens.input) ||
      !isNonNegativeInteger(value.tokens.output) ||
      !isNonNegativeInteger(value.tokens.total)
    ) {
      diagnostics.push(
        error(
          "usage.tokens",
          "Token usage values must be non-negative integers.",
          `${path}.tokens`,
        ),
      );
    } else if (
      value.tokens.total <
      value.tokens.input + value.tokens.output
    ) {
      diagnostics.push(
        error(
          "usage.token-total",
          "Token total cannot be less than input plus output.",
          `${path}.tokens.total`,
        ),
      );
    }
  }
  if (
    value.cost !== undefined &&
    (!isRecord(value.cost) ||
      !isNonNegativeFinite(value.cost.amount) ||
      typeof value.cost.currency !== "string" ||
      !/^[A-Z]{3}$/.test(value.cost.currency))
  ) {
    diagnostics.push(
      error(
        "usage.cost",
        "Cost requires a non-negative amount and ISO 4217 currency code.",
        `${path}.cost`,
      ),
    );
  }
}

function validateOutput(
  value: unknown,
  path: string,
  diagnostics: Diagnostic[],
  requireComplete: boolean,
): void {
  if (
    !isRecord(value) ||
    typeof value.text !== "string" ||
    typeof value.partial !== "boolean"
  ) {
    diagnostics.push(
      error(
        "result.output",
        "Output requires text and partial fields.",
        path,
      ),
    );
  } else if (requireComplete && value.partial) {
    diagnostics.push(
      error(
        "result.output-partial",
        "A completed result cannot report partial output.",
        `${path}.partial`,
      ),
    );
  }
}

function validateRunError(
  value: unknown,
  path: string,
  diagnostics: Diagnostic[],
): void {
  if (
    !isRecord(value) ||
    typeof value.code !== "string" ||
    !value.code ||
    typeof value.message !== "string" ||
    !value.message
  ) {
    diagnostics.push(
      error("result.error", "Error requires code and message strings.", path),
    );
  } else if (
    value.retryable !== undefined &&
    typeof value.retryable !== "boolean"
  ) {
    diagnostics.push(
      error(
        "result.error-retryable",
        "retryable must be boolean.",
        `${path}.retryable`,
      ),
    );
  }
}

function validateReason(
  value: unknown,
  path: string,
  diagnostics: Diagnostic[],
): void {
  if (typeof value !== "string" || !value) {
    diagnostics.push(
      error("result.reason", "Terminal reason must be a non-empty string.", path),
    );
  }
}

function isIsoDate(value: unknown): boolean {
  return (
    typeof value === "string" &&
    !Number.isNaN(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function canonicalValuesEqual(left: unknown, right: unknown): boolean {
  try {
    return canonicalJson(left) === canonicalJson(right);
  } catch {
    return false;
  }
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
