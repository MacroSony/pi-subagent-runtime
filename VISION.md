# Pi Subagent Runtime: Vision and Plan

Pi Subagent Runtime is an execution kernel for Pi subagents. It should be
useful directly, but its primary architectural promise is that another
extension can run a caller-prepared agent without surrendering ownership of
prompts, profiles, tools, policy, workflow, or UI.

This document defines that boundary, the planned public surface, and the work
required to reach an initial release.

## Problem

Pi already has several capable subagent extensions. Most combine execution
with one or more higher-level concerns:

- named agent discovery and bundled presets;
- prompt construction and context inheritance;
- workflow chains, scheduling, memory, or steering;
- worktree management and rich session UI.

Those products are useful when they own the complete subagent experience. They
are harder for another extension to embed without also adopting their prompt,
agent, and orchestration conventions.

Pi Subagent Runtime targets the lower-level gap:

> Run a caller-prepared Pi agent without taking ownership of its prompt,
> profile, policy, workflow, or UI.

The runtime should serve profile managers, review tools, workflow engines,
sandbox providers, remote execution adapters, and other packages that need a
subagent execution provider rather than another orchestration product.

## Design principles

### Prepared, not reinterpreted

A caller can provide an exact system prompt and ordered message sequence. Once
the execution plan is sealed, the runtime and backend must not wrap, rewrite,
or silently downgrade it.

### Policy belongs to the caller

The runtime does not define researcher, planner, reviewer, or worker roles. It
does not choose a model-selection strategy or invent prompt context. A
convenience task API may provide conservative defaults, but the prepared-run
API remains the authoritative integration boundary.

### Capabilities are negotiated before execution

Backends advertise the access modes, limits, media types, cancellation, and
isolation properties they support. A run is rejected during preflight when its
requirements cannot be met.

### Safety claims must match enforcement

Restricting the tools visible to a model is useful, but it is not an operating
system sandbox. Results include an enforcement receipt describing the actual
boundary, such as:

- tool-policy-only versus OS-enforced filesystem access;
- shared-user versus isolated process execution;
- enforced versus unenforced network policy;
- hard, host-abort, best-effort, or unsupported limits.

The runtime must fail closed when a required guarantee cannot be provided.

### Background work is still structured work

Every run has an explicit owner, lifecycle, cancellation path, terminal result,
and bounded retained output. Background execution does not mean detached,
unobservable, or immortal execution.

### Composition over workflow features

Parallel execution is a bounded collection of ordinary runs. Higher-level
chains, DAGs, synthesis, scheduling, and supervisor behavior should be built by
consumers through the API rather than embedded in the execution kernel.

## Intended architecture

The initial release is planned as one npm package with layered exports:

```text
@zihanw/pi-subagent-runtime
├── core                  contracts, runtime, queue, lifecycle, receipts
├── backend               backend interface and capability negotiation
├── backends/sdk          in-process Pi session backend
├── backends/subprocess   child Pi process backend
└── pi                    optional user-facing Pi extension
```

The package has two entry paths:

1. **Prepared runs** for extensions that already own prompts, profiles, tools,
   and policy.
2. **Task runs** for direct users who want a small, conservative subagent
   experience without first installing an orchestration framework.

Both paths resolve to the same sealed execution plan and backend contract.

## Proposed contracts

The exact names may change during the pre-alpha, but the intended service
surface is small:

```ts
interface SubagentRuntime {
  spawn(spec: TaskRun | PreparedRun): RunHandle;
  spawnMany(specs: readonly RunSpec[], options?: BatchOptions): RunHandle[];
  get(id: string): RunSnapshot | undefined;
  list(): RunSnapshot[];
  wait(id: string): Promise<RunResult>;
  cancel(id: string, reason?: string): Promise<void>;
  registerBackend(backend: SubagentBackend): Disposable;
  subscribe(listener: RunEventListener): Disposable;
}
```

A prepared run carries the exact execution intent:

```ts
interface PreparedRun {
  kind: "prepared";
  systemPrompt: string;
  messages: PreparedMessage[];
  model: ModelReference;
  thinkingLevel?: string;
  tools: ToolReference[];
  access: AccessRequest;
  limits: RunLimits;
  provenance?: Record<string, string>;
  fingerprint: string;
}
```

Every spawn returns a handle immediately:

```ts
interface RunHandle {
  id: string;
  snapshot(): RunSnapshot;
  subscribe(listener: RunEventListener): Disposable;
  cancel(reason?: string): Promise<void>;
  result: Promise<RunResult>;
}
```

All runs are asynchronous. A foreground caller awaits `handle.result`; a
background caller retains the handle and continues. Parallel fan-out uses the
same bounded queue.

Direct imports will be the primary integration mechanism. A versioned,
process-local service or Pi event bridge may be provided for sibling extensions
that cannot take a direct package dependency.

## Planned direct-user defaults

The optional Pi extension should make the basics useful without creating a
second orchestration product:

- one small subagent tool;
- single and parallel task submission;
- foreground and session-scoped background execution;
- status, wait, list, and cancel operations;
- a bounded concurrency queue;
- fresh child context by default;
- read-oriented tools by default;
- child extensions and skills disabled by default;
- writable access and recursive delegation disabled by default;
- depth, run-count, timeout, turn, and output limits;
- cancellation propagation and child-process cleanup;
- explicit project-trust checks;
- bounded logs and structured terminal results.

Background jobs in the first release are session-scoped. Durable jobs that
survive Pi restarts require persistence, locking, reconciliation, and migration
semantics and are not part of the initial scope.

## Safety model

A caller states the boundary it requires. A backend returns capabilities during
preflight and, if accepted, an enforcement receipt with the result.

A model-visible read-only tool set does not prove filesystem isolation. For
example, a shared-user subprocess might report:

```ts
{
  executionBoundary: "shared-user",
  filesystem: "tool-policy",
  network: "not-enforced",
  process: "not-exposed-to-agent",
}
```

A sandbox backend may advertise and report stronger enforcement. The common
contract must support both without describing them as equivalent.

The runtime rejects a run when:

- a required access property cannot be enforced;
- the selected model or tool set cannot be provided faithfully;
- an accepted plan differs from the sealed execution fingerprint;
- a backend claims a capability it did not advertise;
- a required hard limit is only available as best-effort.

## Extension points

The runtime should expose stable seams for:

- **backends** — in-process Pi, subprocess Pi, sandboxed, container, or remote;
- **host compilers** — translate profiles, prompt stacks, or domain-specific
  configuration into a prepared run;
- **workspace providers** — allocate and clean up an execution workspace;
- **policy providers** — validate an intent before the plan is sealed;
- **observers** — consume lifecycle events without mutating sealed plans;
- **renderers and UIs** — present progress, results, and history;
- **transports** — offer versioned process-local or remote access to the
  runtime.

Extensions may participate before a plan is sealed or observe it afterward.
They must not mutate an accepted plan during backend execution.

## Initial scope

The first useful release should provide:

1. versioned run, backend, result, and enforcement-receipt contracts;
2. backend registration and capability discovery;
3. preflight, plan sealing, execution, cancellation, and cleanup;
4. an in-process no-tool Pi backend;
5. a conservative Pi subprocess backend;
6. session-scoped background runs and bounded parallel execution;
7. a thin optional Pi extension;
8. conformance tests reusable by third-party backend authors;
9. Pi Forge as the first prepared-run consumer;
10. one independent example extension as proof that the API is not
    Forge-specific.

## Explicit non-goals

The core project does not plan to own:

- bundled agent personas or prompt presets;
- agent Markdown discovery;
- prompt-stack or profile management;
- chain, DAG, or workflow languages;
- cron or scheduled execution;
- persistent agent memory;
- model routing or fallback policy;
- worktree orchestration;
- inter-agent messaging or supervisor interviews;
- rich conversation viewers;
- acceptance criteria or domain-specific result formats.

These may be implemented by consumers or optional companion packages. Keeping
them outside the runtime is a product boundary, not a missing-feature list.

## Relationship to Pi Forge

The runtime is being incubated from the experimental subagent adapter in
[`@zihanw/pi-forge`](https://github.com/MacroSony/pi-forge). Pi Forge will
continue to own profile resolution, prompt-stack compilation, policy, and
fingerprints. It will hand the runtime a sealed prepared plan and verify the
returned enforcement receipt.

Pi Forge is the first consumer, not a required dependency. The runtime API
should remain useful to an extension that knows nothing about Forge profiles or
prompt stacks.

## Roadmap

### 0. Contract

- Extract generic run and backend contracts from Pi Forge.
- Remove Forge-specific profile concepts from the runtime boundary.
- Document safety terminology and invariants.

### 1. Runtime

- Implement lifecycle management, bounded concurrency, cancellation, and
  result retention.
- Port the SDK and subprocess backends.
- Publish backend conformance tests.

### 2. Pi extension

- Add the minimal direct-user tool and status command.
- Validate foreground, background, and parallel behavior.
- Exercise the public API through Pi Forge and an independent example.

### 3. Ecosystem

- Stabilize the process-local service contract.
- Support third-party workspace, sandbox, UI, and remote backends.
- Consider durable background execution only if real consumers require it.

## Project test

The architecture is succeeding if:

- Pi Forge can use it without private integration hooks;
- an unrelated extension can prepare and run agents without adopting Forge;
- backends can be replaced without changing caller-owned prompts or policy;
- unsupported guarantees are rejected rather than silently weakened;
- the default extension remains understandable without learning a workflow
  language.

If the runtime begins accumulating agent presets, prompt opinions, workflow
syntax, or product-specific UI, it has crossed the boundary this project exists
to preserve.
