import assert from "node:assert/strict";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  SourceWorkspaceChangedError,
  applyWorkspaceChanges,
  collectWorkspaceChanges,
  createWorkspaceManifest,
} from "../src/backends/bubblewrap/proposal-workspace.ts";

test("proposal workspace collector reports deterministic text, mode, deletion, and symlink changes", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-subagent-runtime-proposal-source-"));
  const proposal = mkdtempSync(join(tmpdir(), "pi-subagent-runtime-proposal-copy-"));
  try {
    writeFileSync(join(root, "edited.txt"), "before\n", "utf8");
    writeFileSync(join(root, "deleted.txt"), "gone\n", "utf8");
    writeFileSync(join(root, "mode.txt"), "same\n", "utf8");
    symlinkSync("edited.txt", join(root, "link"));
    mkdirSync(join(proposal, "nested"));
    writeFileSync(join(proposal, "edited.txt"), "after\n", "utf8");
    writeFileSync(join(proposal, "mode.txt"), "same\n", "utf8");
    chmodSync(join(proposal, "mode.txt"), 0o755);
    writeFileSync(join(proposal, "nested", "added.txt"), "added\n", "utf8");
    symlinkSync("nested/added.txt", join(proposal, "link"));

    const baseline = createWorkspaceManifest(root);
    const changes = collectWorkspaceChanges({
      sourceRoot: root,
      proposalRoot: proposal,
      baseline,
    });
    assert.deepEqual(
      changes.changes.map((change) => [change.path, change.kind]),
      [
        ["deleted.txt", "deleted"],
        ["edited.txt", "modified"],
        ["link", "symlink-changed"],
        ["mode.txt", "mode-changed"],
        ["nested", "added"],
        ["nested/added.txt", "added"],
      ],
    );
    const edited = changes.changes.find((change) => change.path === "edited.txt");
    assert.equal(edited?.diffStatus, "available");
    assert.match(edited?.diff ?? "", /-before/);
    assert.match(edited?.diff ?? "", /\+after/);
    assert.equal(
      changes.changes.find((change) => change.path === "link")?.diffStatus,
      "unavailable",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(proposal, { recursive: true, force: true });
  }
});

test("proposal workspace apply checks the baseline then materializes files, directories, and links", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-subagent-runtime-proposal-source-"));
  const proposal = mkdtempSync(join(tmpdir(), "pi-subagent-runtime-proposal-copy-"));
  try {
    writeFileSync(join(root, "edited.txt"), "before\n", "utf8");
    writeFileSync(join(root, "deleted.txt"), "delete\n", "utf8");
    writeFileSync(join(root, "mode.txt"), "mode\n", "utf8");
    writeFileSync(join(root, "file-to-directory"), "file\n", "utf8");
    mkdirSync(join(root, "deleted-directory"));
    writeFileSync(join(root, "deleted-directory", "child.txt"), "child\n", "utf8");
    symlinkSync("edited.txt", join(root, "link"));
    const baseline = createWorkspaceManifest(root);
    cpSync(root, proposal, {
      recursive: true,
      force: true,
      preserveTimestamps: true,
      verbatimSymlinks: true,
    });
    writeFileSync(join(proposal, "edited.txt"), "after\n", "utf8");
    rmSync(join(proposal, "deleted.txt"));
    chmodSync(join(proposal, "mode.txt"), 0o755);
    rmSync(join(proposal, "file-to-directory"));
    mkdirSync(join(proposal, "file-to-directory"));
    writeFileSync(join(proposal, "file-to-directory", "child.txt"), "child\n", "utf8");
    rmSync(join(proposal, "deleted-directory"), { recursive: true });
    unlinkSync(join(proposal, "link"));
    symlinkSync("file-to-directory/child.txt", join(proposal, "link"));
    mkdirSync(join(proposal, "added-directory"));
    writeFileSync(join(proposal, "added-directory", "added.txt"), "added\n", "utf8");

    const changeSet = collectWorkspaceChanges({
      sourceRoot: root,
      proposalRoot: proposal,
      baseline,
    });
    applyWorkspaceChanges({
      sourceRoot: root,
      proposalRoot: proposal,
      baseline,
      changeSet,
    });

    assert.deepEqual(createWorkspaceManifest(root), createWorkspaceManifest(proposal));
    assert.equal(readFileSync(join(root, "edited.txt"), "utf8"), "after\n");
    assert.equal(existsSync(join(root, "deleted.txt")), false);
    assert.equal(lstatSync(join(root, "file-to-directory")).isDirectory(), true);
    assert.equal(readlinkSync(join(root, "link")), "file-to-directory/child.txt");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(proposal, { recursive: true, force: true });
  }
});

test("proposal workspace apply rejects source drift before mutating files", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-subagent-runtime-proposal-source-"));
  const proposal = mkdtempSync(join(tmpdir(), "pi-subagent-runtime-proposal-copy-"));
  try {
    writeFileSync(join(root, "source.txt"), "base\n", "utf8");
    const baseline = createWorkspaceManifest(root);
    writeFileSync(join(proposal, "source.txt"), "proposal\n", "utf8");
    const changeSet = collectWorkspaceChanges({
      sourceRoot: root,
      proposalRoot: proposal,
      baseline,
    });
    writeFileSync(join(root, "source.txt"), "concurrent\n", "utf8");
    assert.throws(
      () =>
        applyWorkspaceChanges({
          sourceRoot: root,
          proposalRoot: proposal,
          baseline,
          changeSet,
        }),
      SourceWorkspaceChangedError,
    );
    assert.equal(readFileSync(join(root, "source.txt"), "utf8"), "concurrent\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(proposal, { recursive: true, force: true });
  }
});

test("proposal workspace collector refuses a source changed after its baseline", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-subagent-runtime-proposal-source-"));
  const proposal = mkdtempSync(join(tmpdir(), "pi-subagent-runtime-proposal-copy-"));
  try {
    writeFileSync(join(root, "source.txt"), "base\n", "utf8");
    writeFileSync(join(proposal, "source.txt"), "proposal\n", "utf8");
    const baseline = createWorkspaceManifest(root);
    writeFileSync(join(root, "source.txt"), "concurrent host change\n", "utf8");
    assert.throws(
      () =>
        collectWorkspaceChanges({
          sourceRoot: root,
          proposalRoot: proposal,
          baseline,
        }),
      SourceWorkspaceChangedError,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(proposal, { recursive: true, force: true });
  }
});

test("proposal workspace manifests canonicalize a source-root symlink", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-subagent-runtime-proposal-source-"));
  const linkedParent = mkdtempSync(join(tmpdir(), "pi-subagent-runtime-proposal-link-"));
  const sourceLink = join(linkedParent, "workspace");
  try {
    writeFileSync(join(root, "source.txt"), "base\n", "utf8");
    symlinkSync(root, sourceLink);
    assert.deepEqual(
      createWorkspaceManifest(sourceLink),
      createWorkspaceManifest(root),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(linkedParent, { recursive: true, force: true });
  }
});
