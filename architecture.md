# Architecture

This document is the maintained map of Pi Subagent Runtime: its ownership
boundaries, package layers, execution flow, and planned backend work. Update it
when a public contract, runtime invariant, backend boundary, or planned
architecture changes.

For product scope and historical decisions, see [VISION.md](./VISION.md). This
document describes the implemented structure first, then records agreed work
that has not yet landed.

## Purpose and boundary

Pi Subagent Runtime executes an exact, host-compiled Pi conversation through a
backend selected by that host. It is an execution kernel, not an agent product.

```text
Host application (Forge, review UI, workflow, custom integration)
  owns prompt/task construction, policy, approval, persistence, UI, and apply
                                  |
                                  v
Pi Subagent Runtime
  owns validation, preflight binding, compilation mediation, sealing,
  lifecycle, cancellation, and receipt/result validation
                                  |
                                  v
Execution backend
  owns Pi integration, process launch, OS/tool enforcement, provider
  transport, concrete cleanup, and honest enforcement receipts
```

The runtime checks that a backend's reported result is structurally consistent
with the accepted plan. It does not independently prove an untrusted backend's
claims or provider transport.

## Repository map

```text
src/
├── core/                         Portable public data model; no Pi imports
│   ├── contracts.ts              Intent, plans, fingerprints, results, access
│   ├── validation.ts             Fail-closed pure validators
│   └── canonical.ts              Canonical JSON and SHA-256 fingerprints
├── runtime/                      Portable orchestration kernel; no Pi imports
│   ├── contracts.ts              Backend SPI and public runtime interfaces
│   ├── execution-runtime.ts      Registry, prepare/seal/execute lifecycle
│   └── errors.ts                 Structured runtime errors
├── backends/
│   ├── shared/                   Pi-specific private components shared by
│   │                              process backends
│   ├── subprocess/               Fresh `pi --mode text` read-only backend
│   ├── rpc/                      Fresh `pi --mode rpc` read-only backend
│   └── bubblewrap/               Linux Bubblewrap backends: write-through and
│                                 proposal-write, with the change collector
└── testing/                      Deterministic fake backend and conformance

tests/                            Core, lifecycle, backend, and E2E coverage
examples/independent-host/        Host using only the published package surface
```

The root entry point exports `core` and `runtime`. Pi-dependent backend entry
points are exported separately so a host controls its own Pi package versions.

## Public layers and ownership

| Layer | Main responsibility | Must not own |
| --- | --- | --- |
| `core` | Portable contracts, canonical values, fingerprints, validators | Pi SDK types, process launch, policy decisions |
| `runtime` | Backend registry, preflight validation, plan sealing, run lifecycle | Prompt content, backend selection, approval, workspace setup |
| `backends/shared` | Pi SDK preparation gate, process reporting, trusted bridge utilities | Portable public contracts |
| `backends/subprocess` | Fresh text-mode Pi process | OS isolation beyond its shared-user receipt |
| `backends/rpc` | Fresh RPC-mode Pi process and RPC cancellation | OS isolation beyond its shared-user receipt |
| `backends/bubblewrap` | Linux isolated proposal-write Pi process, proposal lease, guarded apply | Host approval, host-writer serialization, UI/persistence |
| `testing` | Backend conformance fixture and deterministic test backend | Production policy |
| Host | Task/prompt compiler, backend choice, human approval, applying changes | Runtime sealing and backend enforcement claims |

## Contract and lifecycle flow

Preparation is deliberately separate from execution because exact Pi prompt
runtime inputs can be available only inside Pi's `before_agent_start` phase.

```text
Host intent + named backend
          |
          v
backend.preflight(intent)
          |  validates capability/enforcement compatibility
          v
accepted preflight
          |
          v
backend.prepare(preflight, context.compile)
          |  invokes host compiler exactly once
          v
runtime validates and seals plan
          |  conversation fingerprint + backend-bound execution fingerprint
          v
PreparedRun ---- host inspection / approval ---- discard()
          |
          v
runtime.execute(PreparedRun)
          |
          v
backend.start(sealed plan) -> events -> terminal backend result
          |                                  |
          +---------- cancellation ----------+
                                             v
runtime validates/binds result, disposes backend execution, settles RunHandle
```

Important invariants:

- The host compiler owns the final system prompt and ordered messages.
- A backend invokes the compiler exactly once and returns the compiler's prompt
  runtime and conversation unchanged.
- The runtime generates both fingerprints; an inspected snapshot cannot be
  substituted for execution.
- A prepared run can execute once or be discarded.
- Terminal settlement is exactly once, including cancellation and cleanup
  failures.
- A backend receipt must match the access and limit acceptance bound into the
  sealed plan.

## Current process backend design

Both process backends use the same hybrid design.

```text
Parent process
  SdkPreparationGate
    - creates temporary Pi AgentSession
    - blocks provider transport
    - exposes exact prompt runtime to host compiler
    - retains preparation until execute/discard

Fresh child process
  Pi CLI + trusted subprocess bridge
    - receives a unique marker prompt
    - bridge replaces marker with sealed ordered messages
    - bridge installs sealed system prompt
    - bridge blocks tools outside effective allowlist
    - bridge writes sanitized message events to fd 3

Parent process
  - consumes bounded report/event stream
  - owns TERM-to-KILL cancellation escalation
  - returns normalized result and backend-specific retained report
```

| Backend | Pi mode | Current tools | Boundary reported | Notes |
| --- | --- | --- | --- | --- |
| `pi-subprocess-readonly` | `text` | `read`, `grep`, `find`, `ls` | `shared-user` | stdout text mode plus trusted bridge report fd |
| `pi-rpc-readonly` | `rpc` | `read`, `grep`, `find`, `ls` | `shared-user` | strict-LF JSONL RPC, RPC abort then process escalation |

The read-only restriction in these backends is only a model-visible tool
allowlist. They correctly do not claim OS-level filesystem or network
isolation.

## Access model

Portable intent names the desired workspace handles and permissions, but does
not expose host paths:

```text
ExecutionIntent.access
  level: none | read-only | workspace-write
  workspaces: [{ handle, mode }]
  workingDirectory: { workspaceHandle, path }
  executionBoundary: shared-user | isolated
  network: deny | allow
  allowProcess?: boolean
```

The backend resolves handles to host paths privately. Its preflight receipt
maps handles to backend mount IDs and declares actual enforcement capabilities.
For `workspace-write`, the core validator requires truthful
`readWriteMountIsolation` and `symlinkSafeContainment`; enabling a write tool
without these properties is insufficient.

## Reporting and results

`RunResult.output` is the final assistant text. Current process backends also
retain a bounded, sanitized backend-specific `ProcessRunReport`, retrievable
through `takeReport(preparedRunId)`. It contains streamed messages, tool
summaries, usage, stderr, and lifecycle information.

Proposal-capable writers can attach `RunResult.workspaceChanges`: a portable,
validated `WorkspaceChangeSet` containing a backend-local opaque proposal
reference, immutable base/proposal tree fingerprints, path-sorted entry
transitions, and bounded text diffs or explicit omission status. The
filesystem collector is authoritative; final assistant prose remains the
human-readable explanation and test summary.

## Testing model

```text
core tests                 canonicalization and validation invariants
runtime tests              sealing, lifecycle, cancellation, cleanup
fake backend               deterministic malformed/successful SPI behavior
conformance suite          reusable backend execution/discard checks
process backend tests      launch arguments, bridge reports, cancellation
E2E tests                  real Pi child fidelity when explicitly enabled
independent-host tests     public package can be used outside Forge
```

Every new backend should pass the reusable conformance suite and add focused
tests for its claimed enforcement boundary and its failure modes.

## Bubblewrap write-through MVP

### Context and market check

Before integrating a writable subagent backend into a host, we checked how
peer agent products handle writable (sub)agents as of 2026-08:

| Product | Writes | Containment | Review and recovery |
| --- | --- | --- | --- |
| Codex CLI | Direct to workspace | `workspace-write` sandbox (Landlock/Seatbelt); only declared roots writable | git; approval policies `untrusted`/`on-request`/`on-failure`/`never` |
| Claude Code, incl. subagents | Direct; subagents inherit the parent's permission mode | Per-tool allow/deny rules; optional sandbox | git (docs: checkpoints are not a substitute) |
| Gemini CLI | Direct; `auto_edit` auto-approves edit tools | Optional seatbelt/docker sandbox | git |
| Codex subagents (GA 2026-03) | Workers write directly; per-agent `sandbox_mode` override in profile files | Parent sandbox policy inherited | git; approvals surface from child threads |
| Async/cloud agents (Codex Cloud, Copilot coding agent) | Direct inside a per-task container | Container | git branch/PR is the review artifact |

Two patterns dominate: interactive agents use direct write plus a kernel
sandbox plus git recovery; async agents use container isolation plus a git
branch/PR. No major product implements a custom collect-change-set-then-apply
protocol. Codex additionally treats version control as a trust signal: a
workspace not under version control defaults to read-only.

### Decision

The first writable backend this package integrates and recommends is a
Linux write-through Bubblewrap backend:

```text
@zihanw/pi-subagent-runtime/backends/bubblewrap
backend id: pi-bwrap-write
```

It runs Pi with `bash`, read/search, and edit/write tools inside the same
closed Bubblewrap filesystem namespace as the proposal backend, but
bind-mounts the real workspace read-write instead of a proposal copy.
Containment comes from the sandbox: only the workspace is writable and the
rest of the host filesystem is read-only or absent. Review and recovery come
from git. The runtime collects no change set and applies nothing.

The copy-based proposal backend (`pi-bwrap-propose-write`) remains
implemented, tested, and exported as experimental, but leaves the release
critical path. Its lease/change-set/apply machinery targets future
unattended, high-autonomy runs; it is not how interactive hosts review
writes today, and it requires a review/apply UX its hosts do not yet have.
The write-capability model below (no-write / write-through / proposal) is
unchanged; only the ship order changes.

### MVP scope

| Included | Deferred |
| --- | --- |
| Linux and an available working `bwrap` binary | macOS/Windows backends |
| One read-write workspace, used as the working-directory root | Multiple workspace mount routing |
| `network: allow`, needed for direct model provider transport | `network: deny` with a provider/proxy design |
| Built-in `bash`, read/search, edit, and write tools (same catalog as the proposal backend) | Custom host tools and media |
| Git work-tree requirement (overridable) with a dirty-tree warning | Non-git VCS support |
| Read-only `.git` overlay inside the sandbox | Agent-driven git writes (commit/push/stash) |
| Direct write-through; the host reviews with git | Observational diffs on results, change sets, apply |
| Host serializes writers by policy | Parallel-writer coordination (a future worktree backend) |

### Intent and enforcement contract

The accepted intent shape matches the proposal backend: `workspace-write`,
exactly one read-write workspace, the workspace root as working directory,
an isolated execution boundary, `network: allow`, `allowProcess: true`,
text-only tasks, an explicit thinking level, and tools drawn from the
Bubblewrap catalog. Write-through differences:

- The read-write mount is the configured workspace root itself, not a lease
  copy. No proposal lease, revision loop, or change set exists, and
  `RunResult.workspaceChanges` stays absent.
- Git guards at preflight:
  - the workspace root must be inside a git work tree (`git rev-parse`);
    failure is an error unless the host sets `allowNonGitWorkspace`, in
    which case it degrades to a warning;
  - a dirty work tree (`git status --porcelain`) produces a warning,
    because agent edits interleave with pre-existing uncommitted changes.
- Launch guards:
  - when a non-symlink `.git` entry exists at the workspace root it is
    overlaid read-only inside the sandbox, and the child environment sets
    `GIT_OPTIONAL_LOCKS=0`. This protects local git metadata; ordinary
    read-only git commands work in a root checkout but are not guaranteed in
    linked worktrees. When the repository root is an ancestor of the
    workspace root, the sandbox simply does not mount it. Top-level only:
    submodule `.git` entries are a documented gap.
  - everything else matches the proposal launcher: a closed filesystem
    namespace with explicit read-only runtime mounts, private
    `/tmp`/`/proc`/`/dev`, `--die-with-parent`, and `--clearenv` with an
    explicit environment map. Provider authentication must be forwarded
    deliberately through static or selected-model environment values, or Pi's
    explicit `--api-key`; the child never inherits the host environment.

### Honesty notes

This backend must not advertise more than it proves:

- Workspace damage is possible by design; recovery is git. The sandbox
  bounds damage to the workspace and keeps host secrets and unrelated
  directories unreadable.
- network allow plus forwarded provider credentials means the child has
  real egress. Containment is filesystem and process, not network.
- Concurrent writers are not coordinated. Hosts serialize writers by
  policy; parallel write isolation is a future worktree backend's job.

### Relationship to the proposal backend

Write-through reuses, unchanged: the SDK preparation gate, the process
bridge/report plumbing, cancellation and cleanup, Bubblewrap discovery and
verification, the tool catalog, and most intent checks. The launcher learns
one parameterization (the read-write bind source is the real workspace, plus
the `.git` overlay). The proposal backend keeps its own preflight
diagnostics namespace; shared code stays private to `backends/bubblewrap/`.

The backend descriptor currently cannot express mutation mode
(write-through vs proposal); the backend id and documentation carry that
distinction in the MVP. A capability field can be added when a second
proposal-capable backend appears and hosts need to negotiate it.

### Delivered slices

1. **Launcher parameterization and git guards**

   - Read-write bind of the real workspace; read-only `.git` overlay and
     `GIT_OPTIONAL_LOCKS=0`; work-tree detection and dirty-tree warning.

2. **Backend, preflight, and descriptor**

   - `PiBubblewrapWriteBackend` with backend id `pi-bwrap-write`, exported
     from `./backends/bubblewrap`, with honest capability receipts and the
     fail-closed intent checks above.

3. **Verification**

   - Real-Bubblewrap runs whose writes land in the real workspace while
     outside-workspace and `.git` writes fail; no host-environment
     inheritance; non-git rejection plus override; dirty-tree warning;
     cancellation and cleanup. Both Bubblewrap backends join the reusable
     conformance suite, closing the proposal backend's conformance gap.

4. **Documentation**

   - This section, README updates, and the decisions log below.

### Exit criteria for the MVP

- A host can run an isolated writer whose edits are visible in the real
  workspace immediately after the run settles.
- The sandbox blocks writes outside the workspace and any mutation of
  `.git`; both are covered by tests.
- Preflight rejects a non-git workspace by default and warns on a dirty
  tree.
- The child environment is exactly the host-configured map.
- The reusable conformance suite passes for both Bubblewrap backends.
- The proposal backend's tests stay green with no API changes.

### Host integration plan (pi-forge-subagents)

- Selecting a narrow backend in `subagents.json` is the authorization:
  `pi-subprocess-readonly` and `pi-rpc-readonly` project read-only access,
  while `pi-bwrap-write` projects isolated workspace-write access. No
  duplicate `access` setting is added for the MVP.
- Each backend registration owns its fixed access preset and tool catalog;
  host code does not scatter backend-id conditionals. Backend preflight
  independently verifies the projected intent. Provider authentication is
  forwarded through the backend's explicit environment map.
- No review/apply UX is added: the existing pre-execution approval covers
  the run, and git is the review artifact. Host documentation recommends
  delegating against a committed or stashed tree.
- Development consumes this package via a `file:../pi-subagent-runtime`
  dependency; after dogfooding, publish `0.1.0-beta.3` and bump the host
  package's dependency.

**Dogfood status (2026-08-30):** a real Pi host loaded the local Forge and
subagent packages, delegated to `pi-bwrap-write`, reached the selected provider,
and created an exact requested file in the real workspace. The file appeared as
an ordinary untracked git change; repository metadata remained valid. A
hermetic Forge-to-Bubblewrap integration test covers the same access projection
and write path without provider availability.

## Bubblewrap write-proposal MVP

> **Status (2026-08-30):** implemented, tested, and exported as
> experimental, but deferred from the release and host-integration critical
> path in favor of the write-through backend above. The lease, change-set,
> and guarded-apply machinery below resumes for unattended, high-autonomy
> lanes once hosts grow a review UX for it.

### Decision

The first write backend is a Linux-only, Bubblewrap-backed proposal backend,
exported as:

```text
@zihanw/pi-subagent-runtime/backends/bubblewrap
backend id: pi-bwrap-propose-write
```

It gives Pi `bash` as well as `read`, `grep`, `find`, `ls`, `edit`, and
`write`, so the agent can run tests and diagnose/fix its own changes. `bash`
is safe only because the entire Pi child and every subprocess it starts run
inside the same Bubblewrap sandbox.

The backend will operate on an isolated proposal copy, not the original host
workspace. The host alone decides whether to apply the returned proposal after
review.

A proposal is a short-lived, backend-owned workspace lease rather than a
single child process. After a turn settles, the Bubblewrap process and all of
its mounts are cleaned up, but the proposal copy can remain available for the
parent to review and request another edit turn. Each revision is a fresh,
sealed runtime preparation and a fresh Pi child mounted over the same proposal
copy. The host compiles its review feedback and any necessary prior context
into that next turn.

This deliberately does **not** keep the same Pi child alive or steer a settled
child in the MVP. Current process backends are one-shot (`--no-session`) and
`PreparedRun` is one-shot; persistent continuation would require a separate
session/steering protocol, durable child ownership, and new lifecycle states.

### MVP scope

| Included | Deferred |
| --- | --- |
| Linux and an available working `bwrap` binary | macOS/Windows backends |
| One read-write workspace, used as the working-directory root | Multiple workspace mount routing |
| `network: allow`, needed for direct model provider transport | `network: deny` with a provider/proxy design |
| Built-in `bash`, read/search, edit, and write tools | Custom host tools and media |
| Copy-based proposal workspace and bounded diff/manifest | OverlayFS/FUSE/reflink optimization |
| Parent review followed by fresh revision turns on the same proposal copy | Persistent Pi child, RPC resume, or live steering |
| Explicit host approval and guarded apply helper | Automatic application of changes |
| Text diffs plus binary/symlink/mode summaries | Rich binary artifact storage |

The MVP rejects incompatible intents during preflight. In particular it
requires `workspace-write`, an isolated execution boundary, one read-write
workspace, root working directory, and `allowProcess: true`. `bash` causes the
process capability to be requested and must be reported as process-isolated.

### Workspace proposal flow

```text
original host workspace (never mounted read-write in child)
                    |
                    | copy / snapshot; host serializes source writers
                    v
proposal workspace ------------------------+
                    |                       |
                    | rw bind at the same    | immutable baseline manifest
                    | absolute path in bwrap |
                    v                       v
Bubblewrap Pi child + bash/tools       post-run change collector
                    |                       |
                    +-----------+-----------+
                                v
                     ChangeSet + unified diff + assistant explanation
                                |
                          parent review
                 /          |              \
             reject      feedback            apply after base-hash checks
                |            |                         |
             discard     fresh sealed turn              discard
                          on same proposal
```

Mounting the proposal copy at the original absolute workspace path preserves
the exact `cwd` represented by Pi's prepared prompt runtime. The original path
outside the sandbox is never writable by the child.

### Sandbox launch policy

The launcher starts Bubblewrap as the process that owns the Pi child. It must
use a private user, mount, PID, IPC, UTS, and cgroup namespace; retain the
network namespace only for an accepted `network: allow` run; create private
`/tmp`, `/proc`, and `/dev`; set a disposable `HOME`; and use
`--die-with-parent`.

The child filesystem must contain only:

- the proposal workspace as its sole read-write project mount;
- a minimal, explicitly read-only runtime layout needed for Node, Pi, `bash`,
  dynamic libraries, certificates, DNS configuration, and the trusted bridge;
- read-only bridge input and prompt files; and
- private runtime temporary directories.

Do not implement the MVP as `--ro-bind / /` plus a writable workspace and then
claim full workspace isolation: that makes unrelated host files readable. A
launcher may initially support a documented Linux runtime layout only, but
must reject hosts it cannot lay out truthfully.

All inherited file descriptors other than the intended standard streams and
report fd must be closed. Cancellation continues to target the Bubblewrap
parent process, with bounded TERM-to-KILL escalation and `--die-with-parent`
for child-tree cleanup.

### Change-set and apply contract

`WorkspaceChangeSet` is a portable, bounded artifact on terminal results. It
contains:

- an opaque backend-local proposal reference and base/proposal tree fingerprints;
- each added, modified, deleted, mode-changed, or symlink-changed path;
- expected pre-apply state (absence or content/mode/target digest);
- resulting state needed to apply the change;
- a unified diff for bounded UTF-8 text files; and
- explicit summaries when a diff is omitted, truncated, or binary.

The change collector, not the model, is authoritative. The host asks the
compiler to require a concise final explanation and test summary, but treats
that text as commentary alongside the change set.

Application is an explicit host action: pass the exact reviewed
`WorkspaceChangeSet` to the same Bubblewrap backend's `applyProposal()`
method as `applyProposal(reviewedChangeSet)`. It first verifies the reviewed
artifact still matches the current proposal revision (rejecting a stale review
as `proposal-changed`), then checks both the original baseline and retained
proposal tree before its first write. A detected stale source/proposal returns
`conflicted` and writes nothing; an I/O `failed` result is explicitly marked
as potentially partially applied. This is a check-then-apply helper, not a
filesystem transaction, so the host must serialize its other writers around
apply. The runtime never applies a proposal automatically at run completion.

The initial copy strategy assumes the host serializes writers around the
source workspace. A review/revision cycle retains the backend's exclusive
proposal lease until the parent applies or discards it. Every terminal child
run that can be collected reports the cumulative change set from the immutable
base alongside final assistant text. The backend records a base manifest and
refuses to offer an apply-safe proposal if the source tree changes
unexpectedly. Copy limits, proposal expiry, and measured copy cost are
deferred hardening work.

### Write-capability model

Backends should not be split into two permanent families merely because one
can expose a write tool. The existing portable model is intentionally
compositional: a tool's `filesystem-write` effect, `workspace-write` access,
an isolated receipt, and optional process permission express what a particular
run may do.

The important additional dimension is how writes affect the host workspace:

| Mutation mode | Original workspace during run | Result expected | Suitable use |
| --- | --- | --- | --- |
| No-write | Unchanged | Assistant report only | Review/research agents |
| Write-through | Modified immediately | Optional observational diff | Explicitly pre-approved automation |
| Proposal | Unchanged | Authoritative change set; host may apply or revise | Parent-reviewed writer agents |

`WorkspaceChangeSet` is a portable result artifact for every
proposal-capable writer backend, whether it later uses Bubblewrap, a container,
a worktree, or a remote worker. A write-through backend may advertise that it
cannot produce an apply-safe proposal; it must not pretend an after-the-fact
diff makes its writes transactional.

The first Bubblewrap implementation validates this artifact schema in a real
backend. Future capability negotiation should describe proposal and change-set
support separately from filesystem-write tool availability.

### Delivered MVP slices

1. **Contract, preflight, and launch**

   - Export `pi-bwrap-propose-write`; verify a real Bubblewrap executable;
     reject unsupported Linux, workspace, process, tool, and network intents.
   - Launch a fresh Pi child in a closed Bubblewrap filesystem namespace with
     explicit runtime mounts, private `/tmp`, an explicit child environment,
     and `bash` available for tests.

2. **Proposal lease and revision loop**

   - Snapshot one canonicalized source workspace to a private proposal copy;
     mount only that copy read-write at the logical prepared cwd.
   - Keep one single-writer proposal lease across fresh prepare/execute
     revision turns; clean per-turn bridge state and remove the lease on
     explicit discard, successful apply, initial-proposal start failure, or
     backend disposal. A failed revision launch preserves its earlier lease.

3. **Change-set result and host apply**

   - Collect deterministic, cumulative path changes and bounded unified diffs
     after every collectable terminal child run; expose them as
     `RunResult.workspaceChanges` and through proposal inspection.
   - Implement explicit `applyProposal(reviewedChangeSet)`, which rejects
     stale review artifacts and then verifies source/proposal fingerprints
     before writing, returning applied/conflicted/busy/unavailable/failed
     states.

4. **Verification**

   - Test sandbox-local writes, no host-env inheritance, absolute symlink
     containment, revision contention, source conflicts, result validation,
     and guarded application of files/directories/symlinks/modes.

### Exit criteria for the MVP

- A host can prepare an approved isolated write run with `bash`.
- The original workspace remains byte-for-byte unchanged while the run is
  active.
- The terminal result includes a bounded, deterministic change set and an
  independent assistant explanation/test summary.
- Parent review feedback can start a fresh sealed turn on the same proposal
  workspace; the original workspace remains untouched throughout the loop.
- The host can reject the proposal with no workspace mutation.
- Applying a proposal checks both trees and refuses detected conflicts without
  writes. Hosts serialize other source writers; a non-conflict I/O failure is
  explicitly reported as potentially partial rather than transactional.
- Per-turn child state is removed on all terminal paths. A retained proposal
  remains available for review after a collectable terminal run and is removed
  on discard, successful apply, initial-proposal start failure, or backend
  disposal; a failed revision launch restores its existing lease.
- The backend never advertises a stronger filesystem, process, or network
  guarantee than its tested Bubblewrap invocation provides.

## Architecture decisions log

| Date | Decision | Rationale |
| --- | --- | --- |
| 2026-08-18 | Keep host prompt construction, approval, and application outside the execution runtime. | Preserves the package's execution-kernel boundary. |
| 2026-08-18 | Build a copy-based Bubblewrap proposal backend before investigating OverlayFS. | It is portable, reviewable, and does not require host-specific overlay support. |
| 2026-08-18 | Include `bash` in the write-proposal MVP, with `allowProcess: true` and Bubblewrap process isolation. | Writers need to run tests; tool allowlists alone do not safely contain shell commands. |
| 2026-08-18 | Include parent-reviewed revision loops, implemented as fresh Pi children over one retained proposal workspace. | It supports edit/review/fix without prematurely adding persistent child sessions or steering to the runtime. |
| 2026-08-18 | Model writing as a capability and distinguish no-write, write-through, and proposal mutation modes. | Tool availability alone does not describe whether a parent can safely review and apply changes. |
| 2026-08-18 | Treat a collected change set as authoritative and final assistant prose as explanation only. | A model can omit or misdescribe filesystem effects. |
| 2026-08-18 | Make Bubblewrap proposal references backend-local opaque leases and return them in portable change sets. | The core result remains portable without exposing host filesystem paths or forcing a common apply transport. |
| 2026-08-18 | Ship guarded apply as explicit check-then-apply, not a transaction. | Base/proposal checks give a no-write conflict path; cross-process source locking and rollback semantics require a later transactional design. |
| 2026-08-30 | Ship a write-through Bubblewrap backend before integrating the proposal backend's apply lane. | A market check shows interactive agents standardize on direct write plus a kernel sandbox plus git recovery; no major product implements a custom collect/apply protocol, and hosts lack the review UX the proposal flow needs. |
| 2026-08-30 | Require a git work tree (overridable) and overlay `.git` read-only in write-through runs. | git is the recovery layer for direct writes; a workspace without it has no safety net, and a subagent should not mutate version-control state. |
| 2026-08-30 | Keep the proposal backend exported but experimental, off the release critical path. | Its lease/change-set/apply machinery targets future unattended runs; shipping it unchanged preserves the work without committing hosts to its UX. |
| 2026-08-30 | A host derives access and tools from the selected narrow backend registration instead of adding a duplicate per-profile access setting. | Current backend ids are single-mode authorization choices (`readonly` or `write`); a second field would create invalid combinations without adding authority. Preflight still verifies the projected intent fail-closed. |
