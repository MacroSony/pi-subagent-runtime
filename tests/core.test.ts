import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  EXECUTION_CONTRACT_VERSION,
  canonicalJson,
  conversationFingerprint,
  executionFingerprint,
  fingerprint,
  promptRuntimeFingerprint,
  validateAccessEnforcement,
  validateBackendDescriptor,
  validateBackendPreflight,
  validateExecutionIntent,
  validatePreparedConversation,
  validatePromptRuntime,
  validateRunResult,
  validateSealedPlanSnapshot,
  type AccessCapabilities,
  type BackendDescriptor,
  type BackendPreflightAccepted,
  type ExecutionIntent,
  type PreparedConversation,
  type PromptRuntime,
  type RunResult,
  type SealedPlanSnapshot,
} from "../src/core/index.ts";

const TEST_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const SOURCE_DIRECTORY = join(TEST_DIRECTORY, "..", "src", "core");

const ACCESS_CAPABILITIES: AccessCapabilities = {
  readOnlyMountIsolation: true,
  readWriteMountIsolation: true,
  symlinkSafeContainment: true,
  processIsolation: true,
  agentNetworkIsolation: true,
};

function descriptor(
  overrides: Partial<BackendDescriptor> = {},
): BackendDescriptor {
  return {
    id: "fake-backend",
    version: "1.0.0",
    capabilities: {
      access: { ...ACCESS_CAPABILITIES },
      executionBoundaries: ["isolated"],
      limits: {
        timeoutMs: ["backend-hard", "host-abort"],
        maxTurns: ["backend-hard"],
        tokenBudget: ["backend-hard"],
        maxOutputBytes: ["backend-hard"],
      },
      cancellation: true,
      mediaMimeTypes: ["image/png"],
      remoteTransport: false,
      promptRuntimeFidelity: "exact-preflight",
    },
    ...overrides,
  };
}

function intent(
  overrides: Partial<ExecutionIntent> = {},
): ExecutionIntent {
  return {
    model: { provider: "test", id: "model" },
    thinkingLevel: "high",
    requestedTools: ["read"],
    access: {
      level: "read-only",
      executionBoundary: "isolated",
      workspaces: [{ handle: "workspace", mode: "read-only" }],
      workingDirectory: { workspaceHandle: "workspace", path: "." },
      network: "allow",
    },
    limits: {
      timeoutMs: { value: 1_000, enforcement: "best-effort" },
    },
    provenance: { fixture: "core-test" },
    ...overrides,
  };
}

function promptRuntime(
  fidelity: PromptRuntime["fidelity"] = "exact-preflight",
): PromptRuntime {
  const runtime: Omit<PromptRuntime, "promptRuntimeFingerprint"> = {
    baseSystemPrompt: "Base system prompt.",
    options: {
      selectedTools: ["read"],
      toolSnippets: { read: "Read a file." },
      promptGuidelines: ["Use only selected tools."],
      cwd: ".",
      contextFiles: [],
      skills: [],
    },
    model: { provider: "test", id: "model" },
    preparedAt: "2026-07-26T12:00:00.000Z",
    fidelity,
  };
  return {
    ...runtime,
    promptRuntimeFingerprint: promptRuntimeFingerprint(runtime),
  };
}

function conversation(): PreparedConversation {
  return {
    systemPrompt: "You are a precise reviewer.",
    messages: [
      {
        role: "assistant",
        content: [{ type: "text", text: "Prior prepared context." }],
      },
      {
        role: "user",
        content: [{ type: "text", text: "Review the runtime." }],
      },
    ],
  };
}

function preflight(
  executionIntent = intent(),
  backend = descriptor(),
): BackendPreflightAccepted {
  return {
    status: "accepted",
    preflightId: "preflight-1",
    backend,
    model: { ...executionIntent.model },
    thinkingLevel: executionIntent.thinkingLevel ?? "high",
    toolCatalog: [
      {
        id: "tool.read",
        name: "read",
        effects: ["filesystem-read"],
      },
    ],
    access: {
      level: "read-only",
      mounts: [
        {
          workspaceHandle: "workspace",
          mountId: "mount-1",
          mode: "read-only",
        },
      ],
      workingDirectory: { mountId: "mount-1", path: "." },
      network: "allow",
      process: false,
      executionBoundary: "isolated",
      enforcement: { ...ACCESS_CAPABILITIES },
    },
    limits: {
      timeoutMs: { value: 1_000, enforcement: "host-abort" },
    },
    promptRuntime: promptRuntime(),
    diagnostics: [],
  };
}

function plan(): SealedPlanSnapshot {
  const executionIntent = intent();
  const accepted = preflight(executionIntent);
  const preparedConversation = conversation();
  const withoutExecutionFingerprint: Omit<
    SealedPlanSnapshot,
    "executionFingerprint"
  > = {
    schemaVersion: EXECUTION_CONTRACT_VERSION,
    preparedRunId: "prepared-1",
    backendId: accepted.backend.id,
    preflightId: accepted.preflightId,
    intent: executionIntent,
    preflight: accepted,
    promptRuntime: accepted.promptRuntime!,
    conversation: preparedConversation,
    effectiveTools: [
      {
        requestedName: "read",
        backendToolId: "tool.read",
        backendToolName: "read",
      },
    ],
    conversationFingerprint: conversationFingerprint(preparedConversation),
  };
  return {
    ...withoutExecutionFingerprint,
    executionFingerprint: executionFingerprint(withoutExecutionFingerprint),
  };
}

function result(snapshot = plan()): RunResult {
  return {
    schemaVersion: EXECUTION_CONTRACT_VERSION,
    status: "completed",
    runId: "run-1",
    preparedRunId: snapshot.preparedRunId,
    backendId: snapshot.backendId,
    conversationFingerprint: snapshot.conversationFingerprint,
    executionFingerprint: snapshot.executionFingerprint,
    model: { ...snapshot.preflight.model },
    effectiveToolIds: snapshot.effectiveTools.map(
      (tool) => tool.backendToolId,
    ),
    enforcement: {
      access: structuredClone(snapshot.preflight.access),
      limits: structuredClone(snapshot.preflight.limits),
    },
    durationMs: 25,
    usage: {
      tokens: { input: 10, output: 5, total: 15 },
      cost: { amount: 0, currency: "USD" },
    },
    output: { text: "Complete.", partial: false },
  };
}

test("canonical JSON and fingerprints are stable and reject ambiguous values", () => {
  assert.equal(
    canonicalJson({ z: 1, a: { d: 2, b: 1 }, omitted: undefined }),
    '{"a":{"b":1,"d":2},"z":1}',
  );
  assert.equal(fingerprint({ b: 2, a: 1 }), fingerprint({ a: 1, b: 2 }));
  assert.equal(fingerprint(-0), fingerprint(0));
  assert.match(fingerprint("fixture"), /^sha256:v1:[a-f0-9]{64}$/);
  assert.throws(() => canonicalJson(Number.NaN), /non-finite/);
  assert.throws(() => canonicalJson(new Date()), /non-plain/);
  assert.throws(() => canonicalJson(new Array(1)), /sparse array/);
  assert.throws(() => canonicalJson([, 1]), /sparse array/);
  assert.notEqual(canonicalJson([null]), canonicalJson([]));

  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.throws(() => canonicalJson(cyclic), /cyclic/);
});

test("conversation and execution fingerprints bind different layers", () => {
  const firstConversation = conversation();
  const reordered: PreparedConversation = {
    ...firstConversation,
    messages: [...firstConversation.messages].reverse(),
  };
  assert.notEqual(
    conversationFingerprint(firstConversation),
    conversationFingerprint(reordered),
  );

  const snapshot = plan();
  assert.equal(
    executionFingerprint({
      ...snapshot,
      executionFingerprint: fingerprint("forged"),
    }),
    snapshot.executionFingerprint,
  );
  assert.notEqual(
    executionFingerprint({ ...snapshot, backendId: "other-backend" }),
    snapshot.executionFingerprint,
  );
});

test("execution-intent validation rejects contradictory access and duplicate tools", () => {
  assert.deepEqual(validateExecutionIntent(intent()), []);

  const invalid = intent({
    requestedTools: ["read", "read"],
    access: {
      level: "read-only",
      executionBoundary: "isolated",
      workspaces: [{ handle: "workspace", mode: "read-write" }],
      workingDirectory: { workspaceHandle: "missing", path: "../escape" },
      network: "deny",
      allowProcess: true,
    },
    limits: {
      timeoutMs: { value: 0, enforcement: "required" },
      unknown: { value: 1, enforcement: "required" },
    } as ExecutionIntent["limits"],
  });
  const codes = validateExecutionIntent(invalid).map(({ code }) => code);
  assert.ok(codes.includes("array.duplicate"));
  assert.ok(codes.includes("access.read-only-write"));
  assert.ok(codes.includes("access.process-level"));
  assert.ok(codes.includes("access.cwd-workspace"));
  assert.ok(codes.includes("access.cwd-path"));
  assert.ok(codes.includes("limits.requirement"));
  assert.ok(codes.includes("limits.unknown"));
});

test("backend descriptors fail closed on inconsistent capabilities", () => {
  assert.deepEqual(validateBackendDescriptor(descriptor()), []);

  const invalid = descriptor({
    capabilities: {
      ...descriptor().capabilities,
      limits: {
        ...descriptor().capabilities.limits,
        timeoutMs: ["unsupported", "host-abort"],
      },
      mediaMimeTypes: ["not-a-mime"],
    },
  });
  const codes = validateBackendDescriptor(invalid).map(({ code }) => code);
  assert.ok(codes.includes("backend.limit-unsupported"));
  assert.ok(codes.includes("backend.media-mime"));
});

test("prompt runtime and prepared conversation fingerprints detect mutation", () => {
  const runtime = promptRuntime();
  assert.deepEqual(validatePromptRuntime(runtime), []);
  assert.ok(
    validatePromptRuntime({ ...runtime, baseSystemPrompt: "tampered" }).some(
      ({ code }) => code === "prompt-runtime.fingerprint-mismatch",
    ),
  );

  const prepared = conversation();
  assert.deepEqual(validatePreparedConversation(prepared), []);
  assert.ok(
    validatePreparedConversation({ ...prepared, messages: [] }).some(
      ({ code }) => code === "conversation.messages",
    ),
  );
});

test("preflight validation binds model, tools, access, limits, and prompt runtime", () => {
  const executionIntent = intent();
  const backend = descriptor();
  const accepted = preflight(executionIntent, backend);
  assert.deepEqual(
    validateBackendPreflight(accepted, executionIntent, backend),
    [],
  );

  const strictIntent = intent({
    limits: {
      timeoutMs: { value: 1_000, enforcement: "required" },
    },
  });
  const underEnforced = preflight(strictIntent, backend);
  const strictCodes = validateBackendPreflight(
    underEnforced,
    strictIntent,
    backend,
  ).map(({ code }) => code);
  assert.ok(strictCodes.includes("preflight.limit-enforcement"));

  const writeTool = {
    ...accepted,
    toolCatalog: [
      {
        id: "tool.read",
        name: "read",
        effects: ["filesystem-write"] as const,
      },
    ],
  };
  assert.ok(
    validateBackendPreflight(writeTool, executionIntent, backend).some(
      ({ code }) => code === "preflight.tool-effect",
    ),
  );

  const unsupportedDescriptor = descriptor({
    capabilities: {
      ...backend.capabilities,
      access: {
        readOnlyMountIsolation: false,
        readWriteMountIsolation: false,
        symlinkSafeContainment: false,
        processIsolation: false,
        agentNetworkIsolation: false,
      },
      executionBoundaries: ["shared-user"],
      limits: {
        timeoutMs: ["unsupported"],
        maxTurns: ["unsupported"],
        tokenBudget: ["unsupported"],
        maxOutputBytes: ["unsupported"],
      },
    },
  });
  const overstated = {
    ...accepted,
    backend: unsupportedDescriptor,
  };
  const overstatedCodes = validateBackendPreflight(
    overstated,
    executionIntent,
    unsupportedDescriptor,
  ).map(({ code }) => code);
  assert.ok(overstatedCodes.includes("preflight.execution-boundary-capability"));
  assert.ok(overstatedCodes.includes("preflight.access-capability"));
  assert.ok(overstatedCodes.includes("preflight.limit-capability"));
});

test("shared-user receipts do not claim isolation they lack", () => {
  const request = {
    ...intent().access,
    executionBoundary: "shared-user" as const,
  };
  const receipt = {
    ...preflight().access,
    executionBoundary: "shared-user" as const,
    enforcement: {
      readOnlyMountIsolation: false,
      readWriteMountIsolation: false,
      symlinkSafeContainment: false,
      processIsolation: false,
      agentNetworkIsolation: false,
    },
  };
  assert.deepEqual(validateAccessEnforcement(request, receipt), []);

  const deniedNetwork = {
    ...request,
    network: "deny" as const,
  };
  const deniedReceipt = {
    ...receipt,
    network: "deny" as const,
  };
  assert.ok(
    validateAccessEnforcement(deniedNetwork, deniedReceipt).some(
      ({ code }) => code === "preflight.network-isolation",
    ),
  );
});

test("sealed plans validate their bindings and both fingerprints", () => {
  const snapshot = plan();
  assert.deepEqual(validateSealedPlanSnapshot(snapshot), []);

  const changedConversation = {
    ...snapshot,
    conversation: {
      ...snapshot.conversation,
      systemPrompt: "Changed after sealing.",
    },
  };
  const codes = validateSealedPlanSnapshot(changedConversation).map(
    ({ code }) => code,
  );
  assert.ok(codes.includes("plan.conversation-fingerprint"));
  assert.ok(codes.includes("plan.execution-fingerprint"));
});

test("terminal results validate structure and plan binding", () => {
  const snapshot = plan();
  const completed = result(snapshot);
  assert.deepEqual(validateRunResult(completed, snapshot), []);

  const forged = {
    ...completed,
    executionFingerprint: fingerprint("other"),
  };
  assert.ok(
    validateRunResult(forged, snapshot).some(
      ({ code }) => code === "result.execution-binding",
    ),
  );
});

test("public validators report malformed values instead of throwing", () => {
  for (const validate of [
    validateExecutionIntent,
    validateBackendDescriptor,
    validatePromptRuntime,
    validatePreparedConversation,
    validateBackendPreflight,
    validateSealedPlanSnapshot,
    validateRunResult,
  ]) {
    assert.doesNotThrow(() => validate({}));
    assert.ok(validate({}).length > 0);
  }

  const accepted = preflight();
  const cyclicBackend = structuredClone(accepted.backend) as BackendDescriptor &
    Record<string, unknown>;
  cyclicBackend.self = cyclicBackend;
  const cyclicPreflight = { ...accepted, backend: cyclicBackend };
  assert.doesNotThrow(() =>
    validateBackendPreflight(cyclicPreflight, intent(), descriptor()),
  );

  const snapshot = plan();
  const cyclicConversation = structuredClone(
    snapshot.conversation,
  ) as PreparedConversation & Record<string, unknown>;
  cyclicConversation.self = cyclicConversation;
  assert.ok(
    validateSealedPlanSnapshot({
      ...snapshot,
      conversation: cyclicConversation,
    }).some(({ code }) => code === "plan.conversation-canonical"),
  );

  const completed = result(snapshot);
  const cyclicAccess = structuredClone(
    completed.enforcement.access,
  ) as typeof completed.enforcement.access & Record<string, unknown>;
  cyclicAccess.self = cyclicAccess;
  assert.doesNotThrow(() =>
    validateRunResult(
      {
        ...completed,
        enforcement: { ...completed.enforcement, access: cyclicAccess },
      },
      snapshot,
    ),
  );
});

test("portable core has no Pi SDK or Forge imports", async () => {
  for (const name of [
    "canonical.ts",
    "contracts.ts",
    "index.ts",
    "validation.ts",
  ]) {
    const source = await readFile(join(SOURCE_DIRECTORY, name), "utf8");
    assert.doesNotMatch(source, /@earendil-works\/pi-/);
    assert.doesNotMatch(source, /pi-forge|agent-profile|prompt-stack/);
  }
});
