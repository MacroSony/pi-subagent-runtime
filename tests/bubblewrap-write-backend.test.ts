import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
  PI_BUBBLEWRAP_WRITE_BACKEND_ID,
  PiBubblewrapBackend,
  PiBubblewrapWriteBackend,
  findBubblewrapExecutable,
} from "../src/backends/bubblewrap/index.ts";
import { runBackendConformance } from "../src/testing/index.ts";
import { createFixturePiRuntime } from "./helpers/fixture-pi-runtime.ts";

const PROVIDER = "pi-subagent-runtime-bwrap-write-fixture";
const MODEL_ID = "fixture-model";
const API = "pi-subagent-runtime-bwrap-write-api";
const BWRAP_PATH = findBubblewrapExecutable(undefined);
const GIT_AVAILABLE = spawnSync("git", ["--version"]).status === 0;

test(
  "Bubblewrap write-through preflight requires git and warns on dirty work trees",
  { skip: !GIT_AVAILABLE },
  async () => {
    const clean = createGitWorkspace();
    const nonGit = mkdtempSync(join(tmpdir(), "pi-subagent-runtime-bwrap-nongit-"));
    const { modelRegistry, modelRuntime } = await createFixturePiRuntime({
      provider: PROVIDER,
      api: API,
      modelId: MODEL_ID,
    });
    try {
      const cleanBackend = new PiBubblewrapWriteBackend({
        modelRegistry,
        modelRuntime,
        cwd: clean,
        workspaceRoots: { project: clean },
        ...(BWRAP_PATH ? { bwrapPath: BWRAP_PATH } : {}),
      });
      const cleanResult = cleanBackend.preflight(preflightInput());
      if (BWRAP_PATH) assert.equal(cleanResult.status, "accepted");
      assert.equal(
        cleanResult.diagnostics.some((item) => item.code === "pi-bwrap-write.git-dirty"),
        false,
      );

      writeFileSync(join(clean, "dirty.txt"), "dirty\n", "utf8");
      const dirtyResult = cleanBackend.preflight(preflightInput());
      assert.ok(
        dirtyResult.diagnostics.some((item) => item.code === "pi-bwrap-write.git-dirty"),
      );

      const rejectingBackend = new PiBubblewrapWriteBackend({
        modelRegistry,
        modelRuntime,
        cwd: nonGit,
        workspaceRoots: { project: nonGit },
        ...(BWRAP_PATH ? { bwrapPath: BWRAP_PATH } : {}),
      });
      const rejected = rejectingBackend.preflight(preflightInput());
      assert.equal(rejected.status, "rejected");
      assert.ok(
        rejected.diagnostics.some((item) => item.code === "pi-bwrap-write.git-required"),
      );

      const overrideBackend = new PiBubblewrapWriteBackend({
        modelRegistry,
        modelRuntime,
        cwd: nonGit,
        workspaceRoots: { project: nonGit },
        allowNonGitWorkspace: true,
        ...(BWRAP_PATH ? { bwrapPath: BWRAP_PATH } : {}),
      });
      const override = overrideBackend.preflight(preflightInput());
      assert.ok(
        override.diagnostics.some(
          (item) =>
            item.code === "pi-bwrap-write.git-required" &&
            item.level === "warning",
        ),
      );

      await cleanBackend.dispose();
      await rejectingBackend.dispose();
      await overrideBackend.dispose();
    } finally {
      modelRegistry.unregisterProvider(PROVIDER);
      rmSync(clean, { recursive: true, force: true });
      rmSync(nonGit, { recursive: true, force: true });
    }
  },
);

test(
  "Bubblewrap write-through execution edits the real workspace and protects git metadata",
  { skip: process.platform !== "linux" || !BWRAP_PATH || !GIT_AVAILABLE },
  async () => {
    const workspace = createGitWorkspace();
    const outsidePath = join(tmpdir(), `pi-subagent-runtime-bwrap-outside-${process.pid}`);
    writeFileSync(outsidePath, "host-only\n", "utf8");
    symlinkSync(outsidePath, join(workspace, "outside-workspace"));
    runGit(workspace, "add", ".");
    runGit(workspace, "commit", "-m", "add sandbox fixture");

    const secretName = "PI_SUBAGENT_RUNTIME_BWRAP_WRITE_TEST_SECRET";
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
    let preparedPiArgs: string[] | undefined;
    const backend = new PiBubblewrapWriteBackend({
      modelRegistry,
      modelRuntime,
      cwd: workspace,
      workspaceRoots: { project: workspace },
      bwrapPath: BWRAP_PATH!,
      env: { PI_SUBAGENT_RUNTIME_BWRAP_ALLOWED: "available" },
      envForModel: ({ provider, id }) => ({
        PI_SUBAGENT_RUNTIME_BWRAP_MODEL_ENV: `${provider}/${id}`,
      }),
      apiKeyForModel: () => "fixture-api-key",
      invocationFactory: (piArgs) => {
        preparedPiArgs = piArgs;
        return ({
        command: process.execPath,
        args: [
          "--input-type=module",
          "-e",
          `
            const { existsSync, writeFileSync, writeSync } = await import("node:fs");
            if (!existsSync("source.txt")) throw new Error("real workspace was not mounted");
            if (existsSync("outside-workspace")) throw new Error("workspace symlink escaped the sandbox");
            if (process.env.${secretName} !== undefined) throw new Error("host secret reached sandbox");
            if (process.env.PI_SUBAGENT_RUNTIME_BWRAP_ALLOWED !== "available") throw new Error("configured environment was absent");
            if (process.env.PI_SUBAGENT_RUNTIME_BWRAP_MODEL_ENV !== ${JSON.stringify(`${PROVIDER}/${MODEL_ID}`)}) throw new Error("model environment was absent");
            if (process.env.GIT_OPTIONAL_LOCKS !== "0") throw new Error("git optional locks were not disabled");
            writeFileSync("source.txt", "edited directly\\n", "utf8");
            writeFileSync("created-by-child.txt", "direct write\\n", "utf8");
            let gitWriteBlocked = false;
            try { writeFileSync(".git/child-write", "forbidden\\n", "utf8"); }
            catch { gitWriteBlocked = true; }
            if (!gitWriteBlocked) throw new Error("git metadata remained writable");
            writeSync(3, JSON.stringify({
              type: "message_end",
              message: {
                role: "assistant",
                content: [{ type: "text", text: "Bubblewrap direct-write fixture complete." }],
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
      });
      },
    });
    const runtime = createExecutionRuntime();
    runtime.registerBackend(backend);

    try {
      const prepared = await runtime.prepare({
        backendId: PI_BUBBLEWRAP_WRITE_BACKEND_ID,
        intent: fixtureIntent(),
        compile: async () => fixtureConversation(),
      });
      const result = await runtime.execute(prepared).result;
      assert.equal(
        result.status,
        "completed",
        result.status === "failed" ? result.error.message : undefined,
      );
      assert.equal(result.workspaceChanges, undefined);
      assert.deepEqual(
        preparedPiArgs?.slice(preparedPiArgs.indexOf("--api-key"), preparedPiArgs.indexOf("--api-key") + 2),
        ["--api-key", "fixture-api-key"],
      );
      assert.equal(readFileSync(join(workspace, "source.txt"), "utf8"), "edited directly\n");
      assert.equal(readFileSync(join(workspace, "created-by-child.txt"), "utf8"), "direct write\n");
      assert.equal(existsSync(join(workspace, ".git", "child-write")), false);
      assert.equal(backend.takeReport(prepared.id)?.executionBoundary, "isolated");
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

test(
  "Bubblewrap backends pass the reusable conformance suite",
  { skip: process.platform !== "linux" || !BWRAP_PATH || !GIT_AVAILABLE },
  async () => {
    const workspace = createGitWorkspace();
    const { modelRegistry, modelRuntime } = await createFixturePiRuntime({
      provider: PROVIDER,
      api: API,
      modelId: MODEL_ID,
    });
    const common = {
      modelRegistry,
      modelRuntime,
      cwd: workspace,
      workspaceRoots: { project: workspace },
      bwrapPath: BWRAP_PATH!,
      invocationFactory: () => conformanceInvocation(),
    };
    const backends = [
      new PiBubblewrapWriteBackend(common),
      new PiBubblewrapBackend(common),
    ];
    try {
      for (const backend of backends) {
        const report = await runBackendConformance({
          backend,
          intent: fixtureIntent,
          compile: async () => fixtureConversation(),
        });
        assert.equal(report.result.status, "completed");
        assert.ok(report.eventCount > 0);
      }
    } finally {
      await Promise.all(backends.map((backend) => backend.dispose()));
      modelRegistry.unregisterProvider(PROVIDER);
      rmSync(workspace, { recursive: true, force: true });
    }
  },
);

function conformanceInvocation() {
  return {
    command: process.execPath,
    args: [
      "--input-type=module",
      "-e",
      `
        const { writeSync } = await import("node:fs");
        writeSync(3, JSON.stringify({
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Bubblewrap conformance complete." }],
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
}

function createGitWorkspace(): string {
  const workspace = mkdtempSync(join(tmpdir(), "pi-subagent-runtime-bwrap-write-"));
  writeFileSync(join(workspace, "source.txt"), "original\n", "utf8");
  runGit(workspace, "init", "--quiet");
  runGit(workspace, "config", "user.email", "fixture@example.invalid");
  runGit(workspace, "config", "user.name", "Fixture");
  runGit(workspace, "add", "source.txt");
  runGit(workspace, "commit", "--quiet", "-m", "fixture baseline");
  return workspace;
}

function runGit(cwd: string, ...args: string[]): void {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

function preflightInput() {
  return {
    intent: fixtureIntent(),
    signal: new AbortController().signal,
  };
}

function fixtureIntent(): ExecutionIntent {
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
  };
}

function fixtureConversation(): PreparedConversation {
  return {
    systemPrompt: "You are the Bubblewrap direct-write fixture.",
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "Edit the fixture and run its tests." }],
      },
    ],
  };
}
