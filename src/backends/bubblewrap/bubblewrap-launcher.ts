import { existsSync } from "node:fs";
import { dirname, isAbsolute, normalize, sep } from "node:path";

export interface BubblewrapInvocation {
  command: string;
  args: readonly string[];
}

export interface BubblewrapLauncherOptions {
  invocation: BubblewrapInvocation;
  /** Host directory mounted read-write at the logical workspace path. */
  workspaceSourcePath: string;
  /** Optional host .git entry overlaid read-only at workspacePath/.git. */
  gitMetadataPath?: string;
  /** The path Pi observed during preparation and will observe inside bwrap. */
  workspacePath: string;
  /** Per-run bridge input and system prompt directory, mounted read-only. */
  runDirectory: string;
  /** Extra host paths required by the Pi/Node runtime, mounted read-only. */
  runtimeReadOnlyPaths: readonly string[];
  /** Environment passed deliberately into the child after --clearenv. */
  env: Readonly<Record<string, string>>;
}

/**
 * Builds a Linux Bubblewrap invocation with an empty filesystem namespace.
 * The workspace proposal is the only project path mounted read-write; every
 * runtime dependency must be explicitly listed as a read-only mount.
 */
export function bubblewrapArguments(
  options: BubblewrapLauncherOptions,
): string[] {
  const workspacePath = absolutePath(options.workspacePath, "workspacePath");
  const workspaceSourcePath = absolutePath(
    options.workspaceSourcePath,
    "workspaceSourcePath",
  );
  const runDirectory = absolutePath(options.runDirectory, "runDirectory");
  const invocationCommand = absolutePath(
    options.invocation.command,
    "invocation.command",
  );
  const args = [
    "--unshare-all",
    "--unshare-user",
    "--share-net",
    "--die-with-parent",
    "--new-session",
    "--disable-userns",
    "--assert-userns-disabled",
    "--clearenv",
  ];
  const createdDirectories = new Set<string>();
  const ensureDirectory = (path: string): void => {
    if (path === sep) return;
    const normalized = absolutePath(path, "sandbox destination");
    const directories: string[] = [];
    let current = normalized;
    while (current !== sep && !createdDirectories.has(current)) {
      directories.push(current);
      current = dirname(current);
    }
    for (const directory of directories.reverse()) {
      args.push("--dir", directory);
      createdDirectories.add(directory);
    }
  };
  const ensureParent = (path: string): void => ensureDirectory(dirname(path));
  const roBind = (source: string, destination = source): void => {
    const canonicalSource = absolutePath(source, "read-only mount source");
    const canonicalDestination = absolutePath(
      destination,
      "read-only mount destination",
    );
    if (!existsSync(canonicalSource)) {
      throw new Error(`Bubblewrap runtime path does not exist: ${canonicalSource}`);
    }
    ensureParent(canonicalDestination);
    args.push("--ro-bind", canonicalSource, canonicalDestination);
  };

  // Private scratch filesystems come first. Bubblewrap applies operations in
  // order, so a tmpfs mounted after a bind would hide every runtime path,
  // command, run directory or workspace that lives under /tmp.
  ensureDirectory("/tmp");
  args.push("--tmpfs", "/tmp");
  ensureDirectory("/tmp/home");
  ensureDirectory("/proc");
  args.push("--proc", "/proc");
  ensureDirectory("/dev");
  args.push("--dev", "/dev");

  // Dynamic executables need glibc, core command-line tools, certificates,
  // and DNS configuration. These are runtime dependencies, not host project
  // mounts. No broad root filesystem bind is used. Paths under /tmp are bound
  // individually on top of the private tmpfs; the host /tmp itself is never
  // mounted.
  for (const path of defaultRuntimeReadOnlyPaths()) roBind(path);
  for (const path of options.runtimeReadOnlyPaths) {
    if (RESERVED_SANDBOX_PATHS.has(normalize(path))) {
      throw new Error(`Bubblewrap runtime path cannot be a sandbox system directory: ${path}`);
    }
    roBind(path);
  }
  roBind(invocationCommand);

  // This bind intentionally follows the immutable runtime mounts: it is the
  // only read-write project view supplied to the Pi child and its bash tools.
  ensureParent(workspacePath);
  args.push("--bind", workspaceSourcePath, workspacePath);
  if (options.gitMetadataPath) {
    roBind(options.gitMetadataPath, `${workspacePath}/.git`);
  }
  roBind(runDirectory);

  const childEnv = {
    ...options.env,
    HOME: "/tmp/home",
    TMPDIR: "/tmp",
    PATH: "/usr/bin:/bin",
  };
  for (const [key, value] of Object.entries(childEnv)) {
    if (!key || key.includes("=") || key.includes("\0")) {
      throw new Error(`Invalid Bubblewrap environment key: ${key}`);
    }
    if (value.includes("\0")) {
      throw new Error(`Bubblewrap environment value contains NUL: ${key}`);
    }
    args.push("--setenv", key, value);
  }
  args.push("--chdir", workspacePath, "--", invocationCommand, ...options.invocation.args);
  return args;
}

/**
 * Paths needed by dynamically linked Node/Pi processes on ordinary Linux
 * installations. Hosts can add a narrower or additional runtime layout
 * through `runtimeReadOnlyPaths`; all paths are explicit and read-only.
 */
const RESERVED_SANDBOX_PATHS = new Set(["/tmp", "/tmp/home", "/proc", "/dev"]);

export function defaultRuntimeReadOnlyPaths(): readonly string[] {
  return ["/usr", "/lib", "/lib64", "/etc/ssl", "/etc/resolv.conf"];
}

function absolutePath(path: string, label: string): string {
  if (!isAbsolute(path)) {
    throw new Error(`Bubblewrap ${label} must be absolute: ${path}`);
  }
  const normalized = normalize(path);
  if (normalized === sep || !normalized.startsWith(sep)) {
    throw new Error(`Bubblewrap ${label} is unsafe: ${path}`);
  }
  return normalized;
}
