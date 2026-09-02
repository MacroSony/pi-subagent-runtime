import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
  ExecutionIntent,
  PreparedConversation,
} from "../src/core/index.ts";
import { createExecutionRuntime } from "../src/runtime/index.ts";
import {
  PI_BUBBLEWRAP_PROPOSE_WRITE_BACKEND_ID,
  PI_BUBBLEWRAP_PROPOSAL_TOOL_CATALOG,
  PiBubblewrapBackend,
  findBubblewrapExecutable,
  verifyBubblewrapExecutable,
} from "../src/backends/bubblewrap/index.ts";
import { createFixturePiRuntime } from "./helpers/fixture-pi-runtime.ts";

const PROVIDER = "pi-subagent-runtime-bwrap-fixture";
const MODEL_ID = "fixture-model";
const API = "pi-subagent-runtime-bwrap-api";
const BWRAP_PATH = findBubblewrapExecutable(undefined);

test(
  "Bubblewrap proposal backend accepts an isolated writer with bash and exact preparation",
  { skip: !BWRAP_PATH },
  async () => {
  const { faux, modelRegistry, modelRuntime } = await createFixturePiRuntime({
    provider: PROVIDER,
    api: API,
    modelId: MODEL_ID,
  });
  faux.setResponses([
    () => {
      throw new Error("Bubblewrap dry preparation must not contact the provider");
    },
  ]);
  const backend = new PiBubblewrapBackend({
    modelRegistry,
    modelRuntime,
    cwd: process.cwd(),
    workspaceRoots: { project: process.cwd() },
    bwrapPath: BWRAP_PATH!,
  });
  const runtime = createExecutionRuntime();
  runtime.registerBackend(backend);

  try {
    const prepared = await runtime.prepare({
      backendId: PI_BUBBLEWRAP_PROPOSE_WRITE_BACKEND_ID,
      intent: fixtureIntent(),
      compile: async () => fixtureConversation(),
    });
    const plan = prepared.snapshot();
    assert.equal(plan.preflight.access.level, "workspace-write");
    assert.equal(plan.preflight.access.executionBoundary, "isolated");
    assert.equal(plan.preflight.access.process, true);
    assert.equal(plan.preflight.access.enforcement.readWriteMountIsolation, true);
    assert.equal(plan.preflight.access.enforcement.processIsolation, true);
    assert.deepEqual(
      plan.effectiveTools.map((tool) => tool.backendToolName),
      ["read", "grep", "find", "ls", "edit", "write", "bash"],
    );
    assert.deepEqual(
      plan.preflight.toolCatalog.map((tool) => tool.name),
      ["read", "grep", "find", "ls", "edit", "write", "bash"],
    );
    await prepared.discard();

    const ignoredLimit = backend.preflight({
      intent: fixtureIntent({
        limits: {
          maxTurns: { value: 3, enforcement: "best-effort" },
        },
      }),
      signal: new AbortController().signal,
    });
    assert.equal(ignoredLimit.status, "accepted");
    assert.ok(
      ignoredLimit.diagnostics.some(
        (item) => item.code === "pi-bwrap.limit-ignored",
      ),
    );
  } finally {
    await runtime.dispose();
    await backend.dispose();
    modelRegistry.unregisterProvider(PROVIDER);
  }
  },
);

test("Bubblewrap proposal backend fails closed on unsupported workspace or shell access", async () => {
  const { modelRegistry, modelRuntime } = await createFixturePiRuntime({
    provider: PROVIDER,
    api: API,
    modelId: MODEL_ID,
  });
  const backend = new PiBubblewrapBackend({
    modelRegistry,
    modelRuntime,
    cwd: process.cwd(),
    workspaceRoots: { project: process.cwd() },
    bwrapPath: process.execPath,
  });
  try {
    const shared = backend.preflight({
      intent: fixtureIntent({
        access: {
          ...fixtureIntent().access,
          executionBoundary: "shared-user",
        },
      }),
      signal: new AbortController().signal,
    });
    assert.equal(shared.status, "rejected");
    assert.ok(shared.diagnostics.some((item) => item.code === "pi-bwrap.boundary"));

    const noShell = backend.preflight({
      intent: fixtureIntent({
        access: {
          ...fixtureIntent().access,
          allowProcess: false,
        },
      }),
      signal: new AbortController().signal,
    });
    assert.equal(noShell.status, "rejected");
    assert.ok(noShell.diagnostics.some((item) => item.code === "pi-bwrap.process"));

    const unknownWorkspace = backend.preflight({
      intent: fixtureIntent({
        access: {
          ...fixtureIntent().access,
          workspaces: [{ handle: "other", mode: "read-write" }],
          workingDirectory: { workspaceHandle: "other", path: "." },
        },
      }),
      signal: new AbortController().signal,
    });
    assert.equal(unknownWorkspace.status, "rejected");
    assert.ok(
      unknownWorkspace.diagnostics.some(
        (item) => item.code === "pi-bwrap.workspace",
      ),
    );

    const temporaryWorkspace = new PiBubblewrapBackend({
      modelRegistry,
      modelRuntime,
      cwd: tmpdir(),
      workspaceRoots: { project: tmpdir() },
      bwrapPath: process.execPath,
    }).preflight({
      intent: fixtureIntent(),
      signal: new AbortController().signal,
    });
    assert.equal(temporaryWorkspace.status, "rejected");
    assert.ok(
      temporaryWorkspace.diagnostics.some(
        (item) => item.code === "pi-bwrap.workspace-temp-overlap",
      ),
    );

    const missingLauncher = new PiBubblewrapBackend({
      modelRegistry,
      modelRuntime,
      cwd: process.cwd(),
      workspaceRoots: { project: process.cwd() },
      bwrapPath: join(process.cwd(), "missing-bwrap"),
    }).preflight({
      intent: fixtureIntent(),
      signal: new AbortController().signal,
    });
    assert.equal(missingLauncher.status, "rejected");
    assert.ok(
      missingLauncher.diagnostics.some((item) => item.code === "pi-bwrap.bwrap"),
    );
  } finally {
    await backend.dispose();
    modelRegistry.unregisterProvider(PROVIDER);
  }
});

test("Bubblewrap proposal tool catalog declares bash's full authority", () => {
  const bash = PI_BUBBLEWRAP_PROPOSAL_TOOL_CATALOG.find(
    (tool) => tool.name === "bash",
  );
  assert.ok(bash);
  assert.deepEqual(bash.effects, [
    "filesystem-read",
    "filesystem-write",
    "process",
    "network",
  ]);
});

test("Bubblewrap preflight rejects an arbitrary executable as its launcher", () => {
  assert.equal(verifyBubblewrapExecutable(process.execPath), false);
  if (BWRAP_PATH) {
    assert.equal(verifyBubblewrapExecutable(BWRAP_PATH), true);
  }
});

test(
  "Bubblewrap execution writes only an ephemeral proposal copy and carries the report fd",
  { skip: process.platform !== "linux" || !BWRAP_PATH },
  async () => {
    const workspace = mkdtempSync(join(tmpdir(), "pi-subagent-runtime-bwrap-workspace-"));
    writeFileSync(join(workspace, "source.txt"), "original\n", "utf8");
    const outsidePath = join(tmpdir(), "pi-subagent-runtime-bwrap-host-secret");
    writeFileSync(outsidePath, "host-only\n", "utf8");
    symlinkSync(outsidePath, join(workspace, "outside-workspace"));
    const secretName = "PI_SUBAGENT_RUNTIME_BWRAP_TEST_SECRET";
    const previousSecret = process.env[secretName];
    process.env[secretName] = "must-not-reach-bash";
    const { faux, modelRegistry, modelRuntime } = await createFixturePiRuntime({
      provider: PROVIDER,
      api: API,
      modelId: MODEL_ID,
    });
    faux.setResponses([
      () => {
        throw new Error("Bubblewrap dry preparation must not contact the provider");
      },
    ]);
    let invocationCount = 0;
    const backend = new PiBubblewrapBackend({
      modelRegistry,
      modelRuntime,
      cwd: workspace,
      workspaceRoots: { project: workspace },
      env: { PI_SUBAGENT_RUNTIME_BWRAP_ALLOWED: "available" },
      invocationFactory: () => {
        const delayForRevision = invocationCount++ > 0;
        return {
          command: process.execPath,
          args: [
          "--input-type=module",
          "-e",
          `
            const { existsSync, writeFileSync, writeSync } = await import("node:fs");
            if (!existsSync("source.txt")) throw new Error("proposal workspace was not mounted");
            if (existsSync("outside-workspace")) throw new Error("proposal symlink escaped the Bubblewrap namespace");
            if (process.env.${secretName} !== undefined) throw new Error("host secret reached sandbox");
            if (process.env.PI_SUBAGENT_RUNTIME_BWRAP_ALLOWED !== "available") throw new Error("configured environment was absent");
            writeFileSync("created-by-child.txt", "proposal only\\n", "utf8");
            ${delayForRevision ? "writeFileSync(\"revision-by-child.txt\", \"second turn\\n\", \"utf8\");" : ""}
            ${delayForRevision ? "await new Promise((resolve) => setTimeout(resolve, 250));" : ""}
            writeSync(3, JSON.stringify({
              type: "message_end",
              message: {
                role: "assistant",
                content: [{ type: "text", text: "Bubblewrap fixture complete." }],
                api: "fixture",
                provider: ${JSON.stringify(PROVIDER)},
                model: ${JSON.stringify(MODEL_ID)},
                usage: {
                  input: 1,
                  output: 1,
                  cacheRead: 0,
                  cacheWrite: 0,
                  totalTokens: 2,
                  cost: { total: 0 },
                },
                stopReason: "stop",
                timestamp: 1,
              },
            }) + "\\n");
          `,
        ],
        };
      },
    });
    const runtime = createExecutionRuntime();
    runtime.registerBackend(backend);

    try {
      const prepared = await runtime.prepare({
        backendId: PI_BUBBLEWRAP_PROPOSE_WRITE_BACKEND_ID,
        intent: fixtureIntent(),
        compile: async () => fixtureConversation(),
      });
      const result = await runtime.execute(prepared).result;
      assert.equal(
        result.status,
        "completed",
        result.status === "failed" ? result.error.message : undefined,
      );
      if (result.status === "completed") {
        assert.equal(result.output.text, "Bubblewrap fixture complete.");
        assert.ok(
          result.workspaceChanges?.[0]?.changes.some(
            (change) =>
              change.path === "created-by-child.txt" && change.kind === "added",
          ),
        );
      }
      assert.equal(existsSync(join(workspace, "created-by-child.txt")), false);
      assert.equal(backend.takeReport(prepared.id)?.executionBoundary, "isolated");
      const proposal = backend.getProposal(prepared.id);
      assert.ok(proposal);
      assert.equal(proposal.status, "ready");
      assert.equal(proposal.turns, 1);
      assert.ok(
        proposal.changeSet?.changes.some(
          (change) =>
            change.path === "created-by-child.txt" && change.kind === "added",
        ),
      );

      const revision = await runtime.prepare({
        backendId: PI_BUBBLEWRAP_PROPOSE_WRITE_BACKEND_ID,
        intent: fixtureIntent({
          workspaceProposal: {
            id: proposal.id,
            workspaceHandle: proposal.workspaceHandle,
          },
        }),
        compile: async () => fixtureConversation(),
      });
      const competingRevision = await runtime.prepare({
        backendId: PI_BUBBLEWRAP_PROPOSE_WRITE_BACKEND_ID,
        intent: fixtureIntent({
          workspaceProposal: {
            id: proposal.id,
            workspaceHandle: proposal.workspaceHandle,
          },
        }),
        compile: async () => fixtureConversation(),
      });
      const revisionRun = runtime.execute(revision);
      const competingRun = runtime.execute(competingRevision);
      const [revisionResult, competingResult] = await Promise.all([
        revisionRun.result,
        competingRun.result,
      ]);
      // The two starts race asynchronously, so either competitor may win; the
      // contract guarantees exactly one runs and the other fails cleanly.
      const results = [revisionResult, competingResult];
      const winnerResult = results.find((result) => result.status === "completed");
      const loserResult = results.find((result) => result.status === "failed");
      assert.ok(winnerResult, "exactly one competing revision should run");
      assert.ok(loserResult, "the losing revision should fail");
      if (loserResult.status === "failed") {
        assert.match(loserResult.error.message, /not ready for a run/);
      }
      const winnerPrepared =
        winnerResult === revisionResult ? revision : competingRevision;
      const revisedProposal = backend.getProposal(winnerPrepared.id);
      assert.ok(revisedProposal);
      assert.equal(revisedProposal.id, proposal.id);
      assert.equal(revisedProposal.turns, 2);
      assert.ok(revisedProposal.changeSet);
      assert.ok(proposal.changeSet);
      const staleApply = await backend.applyProposal(proposal.changeSet);
      assert.equal(staleApply.status, "conflicted");
      if (staleApply.status === "conflicted") {
        assert.equal(staleApply.reason, "proposal-changed");
      }
      const applied = await backend.applyProposal(revisedProposal.changeSet);
      assert.equal(applied.status, "applied");
      assert.equal(
        readFileSync(join(workspace, "created-by-child.txt"), "utf8"),
        "proposal only\n",
      );
      assert.equal(backend.getProposal(prepared.id), undefined);
    } finally {
      await runtime.dispose();
      await backend.dispose();
      modelRegistry.unregisterProvider(PROVIDER);
      rmSync(workspace, { recursive: true, force: true });
      rmSync(outsidePath, { force: true });
      if (previousSecret === undefined) delete process.env[secretName];
      else process.env[secretName] = previousSecret;
    }
  },
);

function fixtureIntent(overrides: Partial<ExecutionIntent> = {}): ExecutionIntent {
  return {
    model: { provider: PROVIDER, id: MODEL_ID },
    thinkingLevel: "high",
    requestedTools: ["read", "grep", "find", "ls", "edit", "write", "bash"],
    access: {
      level: "workspace-write",
      executionBoundary: "isolated",
      workspaces: [{ handle: "project", mode: "read-write" }],
      workingDirectory: { workspaceHandle: "project", path: "." },
      network: "allow",
      allowProcess: true,
    },
    limits: { timeoutMs: { value: 30_000, enforcement: "best-effort" } },
    ...overrides,
  };
}

function fixtureConversation(): PreparedConversation {
  return {
    systemPrompt: "You are the Bubblewrap fixture writer.",
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "Edit the fixture and run its tests." }],
      },
    ],
  };
}
