import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { bubblewrapArguments } from "../src/backends/bubblewrap/bubblewrap-launcher.ts";
import { findBubblewrapExecutable } from "../src/backends/bubblewrap/index.ts";

const BWRAP_PATH = findBubblewrapExecutable(undefined);
const REQUIRE_BWRAP = process.env.PI_SUBAGENT_RUNTIME_REQUIRE_BWRAP === "1";

test("release gates can require real Bubblewrap instead of skipping", () => {
  if (!REQUIRE_BWRAP) return;
  assert.equal(process.platform, "linux");
  assert.ok(BWRAP_PATH, "PI_SUBAGENT_RUNTIME_REQUIRE_BWRAP=1 but bwrap was not found");
});

test("the private /tmp is mounted before runtime binds", { skip: process.platform !== "linux" }, () => {
  const root = mkdtempSync(join(tmpdir(), "pi-subagent-runtime-bwrap-order-"));
  try {
    for (const dir of ["runtime", "ws", "run"]) mkdirSync(join(root, dir));
    writeFileSync(join(root, "runtime", "cmd"), "");
    const args = bubblewrapArguments({
      invocation: { command: join(root, "runtime", "cmd"), args: [] },
      workspaceSourcePath: join(root, "ws"),
      workspacePath: join(root, "ws"),
      runDirectory: join(root, "run"),
      runtimeReadOnlyPaths: [join(root, "runtime")],
      env: {},
    });
    const tmpfs = args.indexOf("--tmpfs");
    assert.ok(tmpfs >= 0);
    const firstBind = args.findIndex((arg) => arg === "--ro-bind" || arg === "--bind");
    assert.ok(firstBind > tmpfs, "every bind must come after the /tmp tmpfs");
    const alias = join(root, "tmp-alias");
    if (process.platform !== "win32") symlinkSync("/tmp", alias);
    for (const forbidden of ["/tmp", "/tmp/", "/tmp/home/", "/proc/", "/dev/", ...(process.platform !== "win32" ? [alias] : [])]) {
    assert.throws(
      () =>
        bubblewrapArguments({
          invocation: { command: join(root, "runtime", "cmd"), args: [] },
          workspaceSourcePath: join(root, "ws"),
          workspacePath: join(root, "ws"),
          runDirectory: join(root, "run"),
          runtimeReadOnlyPaths: [forbidden],
          env: {},
        }),
      /cannot be a sandbox system directory/,
    );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test(
  "real Bubblewrap runs a command, runtime, run directory and workspace that all live under /tmp",
  { skip: !REQUIRE_BWRAP && (process.platform !== "linux" || !BWRAP_PATH) },
  () => {
    const root = mkdtempSync(join(tmpdir(), "pi-subagent-runtime-bwrap-tmp-"));
    try {
      const runtimeRoot = join(root, "runtime");
      mkdirSync(join(runtimeRoot, "bin"), { recursive: true });
      const node = join(runtimeRoot, "bin", "node");
      copyFileSync(process.execPath, node);
      chmodSync(node, 0o755);
      const workspace = join(root, "ws");
      const runDirectory = join(root, "run");
      mkdirSync(workspace);
      mkdirSync(runDirectory);
      writeFileSync(join(workspace, "hello.txt"), "workspace ok");
      writeFileSync(join(runDirectory, "input.json"), "{}");
      const secret = join(root, "host-secret.txt");
      writeFileSync(secret, "do not leak");
      symlinkSync(secret, join(workspace, "outside-link"));

      const script = `
        const fs = require("node:fs");
        const read = (p) => { try { return fs.readFileSync(p, "utf8"); } catch (e) { return "ERR:" + e.code; } };
        let tmpWritable = false;
        try { fs.writeFileSync("/tmp/scratch", "x"); tmpWritable = fs.readFileSync("/tmp/scratch", "utf8") === "x"; } catch {}
        console.log(JSON.stringify({
          workspace: read(${JSON.stringify(join(workspace, "hello.txt"))}),
          runInput: fs.existsSync(${JSON.stringify(join(runDirectory, "input.json"))}),
          secret: read(${JSON.stringify(secret)}),
          outsideLink: read(${JSON.stringify(join(workspace, "outside-link"))}),
          tmpWritable,
          home: process.env.HOME,
        }));`;
      const args = bubblewrapArguments({
        invocation: { command: node, args: ["-e", script] },
        workspaceSourcePath: workspace,
        workspacePath: workspace,
        runDirectory,
        runtimeReadOnlyPaths: [runtimeRoot],
        env: {},
      });
      const result = spawnSync(BWRAP_PATH!, args, { encoding: "utf8", timeout: 30_000 });
      assert.equal(result.status, 0, `bwrap failed: ${result.stderr}`);
      const observed = JSON.parse(result.stdout.trim());
      assert.deepEqual(observed, {
        workspace: "workspace ok",
        runInput: true,
        secret: "ERR:ENOENT",
        outsideLink: "ERR:ENOENT",
        tmpWritable: true,
        home: "/tmp/home",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
