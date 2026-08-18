import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import {
  canonicalJson,
  fingerprint,
  isSafeRelativePath,
  type Fingerprint,
  type WorkspaceChange,
  type WorkspaceChangeKind,
  type WorkspaceDiffStatus,
  type WorkspaceEntryState,
} from "../../core/index.ts";

export const MAX_PROPOSAL_TEXT_DIFF_BYTES = 256 * 1024;
export const MAX_PROPOSAL_TOTAL_DIFF_BYTES = 512 * 1024;

export type WorkspaceManifestEntry = WorkspaceEntryState;

export interface WorkspaceManifest {
  treeFingerprint: Fingerprint;
  entries: readonly WorkspaceManifestEntry[];
  fileCount: number;
  totalBytes: number;
}

export type CollectedWorkspaceChange = WorkspaceChange;

export interface CollectedWorkspaceChangeSet {
  baseTreeFingerprint: Fingerprint;
  proposalTreeFingerprint: Fingerprint;
  changes: readonly CollectedWorkspaceChange[];
  totalDiffBytes: number;
}

export class SourceWorkspaceChangedError extends Error {
  constructor() {
    super(
      "Original workspace changed while the proposal lease was active; the proposal cannot be applied safely.",
    );
    this.name = "SourceWorkspaceChangedError";
  }
}

export class ProposalWorkspaceChangedError extends Error {
  constructor() {
    super(
      "Proposal workspace changed after its change set was collected; the proposal cannot be applied safely.",
    );
    this.name = "ProposalWorkspaceChangedError";
  }
}

/** Creates a path-sorted, content-addressed manifest without following links. */
export function createWorkspaceManifest(root: string): WorkspaceManifest {
  // Resolve the root itself before copying or walking it. A source-root
  // symlink must never become a proposal-root symlink that a later bind mount
  // would follow back to the original workspace.
  const canonicalRoot = realpathSync(root);
  if (!lstatSync(canonicalRoot).isDirectory()) {
    throw new Error(`Proposal workspace root is not a directory: ${root}.`);
  }
  const entries: WorkspaceManifestEntry[] = [];
  let totalBytes = 0;
  const visit = (absolutePath: string): void => {
    const stat = lstatSync(absolutePath);
    const path = manifestPath(canonicalRoot, absolutePath);
    const mode = stat.mode & 0o7777;
    if (stat.isDirectory()) {
      if (path) entries.push({ path, kind: "directory", mode });
      const children = readdirSync(absolutePath, { withFileTypes: true })
        .map(({ name }) => name)
        .sort(comparePath);
      for (const child of children) visit(`${absolutePath}${sep}${child}`);
      return;
    }
    if (stat.isSymbolicLink()) {
      entries.push({
        path,
        kind: "symlink",
        mode,
        target: readlinkSync(absolutePath),
      });
      return;
    }
    if (stat.isFile()) {
      const content = readFileSync(absolutePath);
      totalBytes += content.length;
      entries.push({
        path,
        kind: "file",
        mode,
        size: content.length,
        digest: digestBytes(content),
      });
      return;
    }
    throw new Error(
      `Proposal workspace contains unsupported filesystem entry: ${path || absolutePath}.`,
    );
  };
  visit(canonicalRoot);
  return {
    treeFingerprint: fingerprint(entries),
    entries,
    fileCount: entries.filter((entry) => entry.kind === "file").length,
    totalBytes,
  };
}

/**
 * Produces deterministic cumulative changes from `baseline` to `proposal`.
 * The source is hashed again first: concurrent host writes invalidate the
 * proposal rather than contaminating its diff or later apply preconditions.
 */
export function collectWorkspaceChanges(input: {
  sourceRoot: string;
  proposalRoot: string;
  baseline: WorkspaceManifest;
}): CollectedWorkspaceChangeSet {
  const sourceNow = createWorkspaceManifest(input.sourceRoot);
  if (sourceNow.treeFingerprint !== input.baseline.treeFingerprint) {
    throw new SourceWorkspaceChangedError();
  }
  const proposal = createWorkspaceManifest(input.proposalRoot);
  const before = new Map(
    input.baseline.entries.map((entry) => [entry.path, entry]),
  );
  const after = new Map(proposal.entries.map((entry) => [entry.path, entry]));
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort(comparePath);
  let remainingDiffBytes = MAX_PROPOSAL_TOTAL_DIFF_BYTES;
  const changes: CollectedWorkspaceChange[] = [];
  for (const path of paths) {
    const beforeEntry = before.get(path);
    const afterEntry = after.get(path);
    if (beforeEntry && afterEntry && canonicalJson(beforeEntry) === canonicalJson(afterEntry)) {
      continue;
    }
    const kind = changeKind(beforeEntry, afterEntry);
    const textDiff = collectTextDiff({
      path,
      before: beforeEntry,
      after: afterEntry,
      sourceRoot: input.sourceRoot,
      proposalRoot: input.proposalRoot,
      maxBytes: remainingDiffBytes,
    });
    if (textDiff.diff) {
      remainingDiffBytes -= Buffer.byteLength(textDiff.diff, "utf8");
    }
    changes.push({
      path,
      kind,
      ...(beforeEntry ? { before: structuredClone(beforeEntry) } : {}),
      ...(afterEntry ? { after: structuredClone(afterEntry) } : {}),
      diffStatus: textDiff.status,
      ...(textDiff.diff ? { diff: textDiff.diff } : {}),
    });
  }
  return {
    baseTreeFingerprint: input.baseline.treeFingerprint,
    proposalTreeFingerprint: proposal.treeFingerprint,
    changes,
    totalDiffBytes: MAX_PROPOSAL_TOTAL_DIFF_BYTES - remainingDiffBytes,
  };
}

/**
 * Applies an already-collected proposal only after proving that both its
 * source baseline and its retained proposal copy still match. Preconditions
 * are checked before the first mutation; individual file replacement is
 * staged through same-directory atomic renames. This is deliberately a
 * check-then-apply operation, not a filesystem transaction: callers must
 * serialize host writers, and an I/O failure after mutation begins can leave
 * a partial apply. Callers retain ownership of lease disposal and must
 * discard the proposal after a successful apply.
 */
export function applyWorkspaceChanges(input: {
  sourceRoot: string;
  proposalRoot: string;
  baseline: WorkspaceManifest;
  changeSet: CollectedWorkspaceChangeSet;
}): void {
  const sourceRoot = realpathSync(input.sourceRoot);
  const proposalRoot = realpathSync(input.proposalRoot);
  const current = collectWorkspaceChanges({
    sourceRoot,
    proposalRoot,
    baseline: input.baseline,
  });
  if (canonicalJson(current) !== canonicalJson(input.changeSet)) {
    throw new ProposalWorkspaceChangedError();
  }

  const changes = [...input.changeSet.changes];
  const removals = changes
    .filter(
      (change) =>
        change.after === undefined ||
        (change.before !== undefined && change.before.kind !== change.after.kind),
    )
    .sort(compareDeepestFirst);
  for (const change of removals) removeDestination(sourceRoot, change.path);

  const directories = changes
    .filter(
      (change) =>
        change.after?.kind === "directory" &&
        (change.before?.kind !== "directory"),
    )
    .sort(compareShallowestFirst);
  for (const change of directories) {
    mkdirSync(destinationPath(sourceRoot, change.path), { mode: 0o755 });
  }

  for (const change of changes) {
    const after = change.after;
    if (!after || after.kind === "directory") continue;
    const destination = destinationPath(sourceRoot, change.path);
    if (after.kind === "file") {
      replaceFileFromProposal(
        destination,
        destinationPath(proposalRoot, change.path),
        after.mode,
      );
    } else {
      replaceSymlink(destination, after.target!);
    }
  }

  for (const change of changes) {
    if (change.after?.kind === "directory") {
      chmodSync(destinationPath(sourceRoot, change.path), change.after.mode);
    }
  }

  if (
    createWorkspaceManifest(sourceRoot).treeFingerprint !==
    input.changeSet.proposalTreeFingerprint
  ) {
    throw new Error("Proposal application did not produce the expected workspace tree.");
  }
}

function manifestPath(root: string, absolutePath: string): string {
  const path = relative(root, absolutePath).split(sep).join("/");
  if (!path || path === ".") return "";
  if (path.startsWith("../") || path === "..") {
    throw new Error(`Workspace entry escaped its root: ${absolutePath}.`);
  }
  return path;
}

function destinationPath(root: string, path: string): string {
  if (!isSafeRelativePath(path)) {
    throw new Error(`Unsafe proposal change path: ${path}.`);
  }
  const destination = resolve(root, path);
  const contained = relative(root, destination);
  if (!contained || contained === ".." || contained.startsWith(`..${sep}`)) {
    throw new Error(`Proposal change path escaped its workspace: ${path}.`);
  }
  return destination;
}

function compareDeepestFirst(
  left: CollectedWorkspaceChange,
  right: CollectedWorkspaceChange,
): number {
  const depth = right.path.split("/").length - left.path.split("/").length;
  return depth || comparePath(right.path, left.path);
}

function compareShallowestFirst(
  left: CollectedWorkspaceChange,
  right: CollectedWorkspaceChange,
): number {
  const depth = left.path.split("/").length - right.path.split("/").length;
  return depth || comparePath(left.path, right.path);
}

/** Bytewise string ordering keeps manifests stable across host locales. */
function comparePath(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function removeDestination(root: string, path: string): void {
  const destination = destinationPath(root, path);
  const stat = lstatSync(destination);
  if (stat.isDirectory()) rmdirSync(destination);
  else unlinkSync(destination);
}

function replaceFileFromProposal(
  destination: string,
  proposalSource: string,
  mode: number,
): void {
  const temporary = join(
    dirname(destination),
    `.pi-subagent-runtime-apply-${randomUUID()}`,
  );
  try {
    writeFileSync(temporary, readFileSync(proposalSource), {
      mode,
      flag: "wx",
    });
    chmodSync(temporary, mode);
    renameSync(temporary, destination);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function replaceSymlink(destination: string, target: string): void {
  const temporary = join(
    dirname(destination),
    `.pi-subagent-runtime-apply-${randomUUID()}`,
  );
  try {
    symlinkSync(target, temporary);
    renameSync(temporary, destination);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function digestBytes(content: Buffer): Fingerprint {
  return `sha256:v1:${createHash("sha256").update(content).digest("hex")}`;
}

function changeKind(
  before: WorkspaceManifestEntry | undefined,
  after: WorkspaceManifestEntry | undefined,
): WorkspaceChangeKind {
  if (!before) return "added";
  if (!after) return "deleted";
  if (before.kind !== after.kind) return "type-changed";
  if (before.kind === "symlink" && before.target !== after.target) {
    return "symlink-changed";
  }
  if (sameContent(before, after) && before.mode !== after.mode) {
    return "mode-changed";
  }
  return "modified";
}

function sameContent(
  before: WorkspaceManifestEntry,
  after: WorkspaceManifestEntry,
): boolean {
  return (
    before.kind === after.kind &&
    before.digest === after.digest &&
    before.target === after.target &&
    before.size === after.size
  );
}

function collectTextDiff(input: {
  path: string;
  before: WorkspaceManifestEntry | undefined;
  after: WorkspaceManifestEntry | undefined;
  sourceRoot: string;
  proposalRoot: string;
  maxBytes: number;
}): { status: WorkspaceDiffStatus; diff?: string } {
  if (input.maxBytes <= 0) return { status: "truncated" };
  if (
    (input.before && input.before.kind !== "file") ||
    (input.after && input.after.kind !== "file")
  ) {
    return { status: "unavailable" };
  }
  const beforePath = input.before
    ? `${resolve(input.sourceRoot)}${sep}${input.path}`
    : "/dev/null";
  const afterPath = input.after
    ? `${resolve(input.proposalRoot)}${sep}${input.path}`
    : "/dev/null";
  if (!isBoundedText(beforePath) || !isBoundedText(afterPath)) {
    return {
      status:
        isTooLarge(beforePath) || isTooLarge(afterPath) ? "too-large" : "binary",
    };
  }
  const result = spawnSync(
    "diff",
    [
      "-u",
      "--label",
      `a/${input.path}`,
      "--label",
      `b/${input.path}`,
      beforePath,
      afterPath,
    ],
    {
      encoding: "utf8",
      maxBuffer: input.maxBytes,
      windowsHide: true,
    },
  );
  if (result.status === 0) return { status: "available" };
  if (result.status !== 1 || result.error) return { status: "unavailable" };
  const diff = result.stdout;
  if (Buffer.byteLength(diff, "utf8") > input.maxBytes) {
    return { status: "truncated" };
  }
  return { status: "available", diff };
}

function isBoundedText(path: string): boolean {
  if (path === "/dev/null") return true;
  try {
    const content = readFileSync(path);
    if (content.length > MAX_PROPOSAL_TEXT_DIFF_BYTES) return false;
    if (content.includes(0)) return false;
    new TextDecoder("utf-8", { fatal: true }).decode(content);
    return true;
  } catch {
    return false;
  }
}

function isTooLarge(path: string): boolean {
  if (path === "/dev/null") return false;
  try {
    return readFileSync(path).length > MAX_PROPOSAL_TEXT_DIFF_BYTES;
  } catch {
    return false;
  }
}
