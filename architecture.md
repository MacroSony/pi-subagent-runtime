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
│   └── bubblewrap/               Linux proposal-write backend and change collector
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

## Bubblewrap write-proposal MVP

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
