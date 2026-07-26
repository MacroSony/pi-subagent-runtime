# Pi Subagent Runtime: Vision and Implementation Plan

## Status and decision

Pi Subagent Runtime is a pure execution kernel for caller-prepared Pi agents.
It is infrastructure for other extensions and applications, not another
user-facing subagent product.

The initial release will not register a model-callable tool, discover agent
personas, construct task prompts, own a UI, or provide workflows. Pi Forge is
the first host: it owns profiles, prompt compilation, policy, approval, and
presentation, while this package owns execution integrity and lifecycle.

## Problem

Pi has capable user-facing subagent packages and more than one package with a
programmatic API. The missing boundary is narrower:

> Execute a caller-compiled, ordered Pi conversation through an explicitly
> selected backend, without reinterpreting it, silently weakening its
> requirements, or overstating the boundary that was enforced.

A profile manager, review tool, workflow engine, sandbox provider, or remote
execution service should be able to use a Pi agent without adopting a runtime's
agent-file format, prompt conventions, model routing, workflow syntax, or UI.

## Ownership boundary

The host owns:

- profiles, prompt stacks, personas, and task semantics;
- selected context and the exact ordered conversation;
- model and backend selection policy;
- requested tools, access, limits, and provider-egress consent;
- human approval and other authorization decisions;
- workflows, retries, scheduling, parallel fan-out, and result synthesis;
- UI, persistence, artifacts, and product-specific result formats.

The runtime owns:

- backend registration and descriptor validation;
- preflight and capability negotiation;
- mediation of exact or backend-assisted host preparation;
- plan validation, sealing, binding, and runtime-generated conversation and
  execution fingerprints;
- public lifecycle, event delivery, cancellation arbitration, and exactly-once
  terminal settlement;
- invocation and verification of backend preparation and execution cleanup;
- bounded in-memory diagnostics and terminal result normalization;
- validation of backend enforcement receipts against accepted capabilities.

The backend owns:

- model, authentication, tool, media, and runtime discovery;
- faithful materialization of the prepared system prompt and ordered messages;
- process, workspace, network, and tool enforcement it claims to provide;
- implementation of accepted limits;
- provider transport, streaming, cancellation handling, and actual resource
  cleanup when the runtime invokes its lifecycle hooks;
- an accurate enforcement receipt describing what happened.

An enforcement receipt is a backend attestation, not independent proof. The
runtime validates its consistency and publishes conformance tests, but callers
must decide which backend implementations they trust.

## Design principles

### Prepared, not reinterpreted

The host compiler produces the final system prompt and ordered message
sequence. The runtime and backend must not add role instructions, task
wrappers, inherited context, skills, or other model-visible content after the
plan is sealed.

### Preparation is explicitly two-phase

Some Pi prompt inputs are available only inside `before_agent_start`.
Therefore a host cannot always compile the exact plan before accepting a
backend. The contract must support:

```text
host execution intent
    -> explicit backend preflight
    -> exact or backend-assisted host compilation
    -> runtime validation and plan sealing
    -> optional host approval
    -> execution
```

The host compiler remains authoritative even when a backend supplies runtime
inputs. A backend may invoke the compiler through the runtime, but may not
replace or modify its result.

### Backend selection is caller policy

Every preparation names a backend ID. The runtime does not select the first
compatible backend or silently fall back to another one. A host may implement
its own selection policy by inspecting registered descriptors.

If an application wants a default backend, it must configure that default
explicitly outside the core runtime.

### Capabilities are negotiated before provider transport

Backends advertise prompt fidelity, model and tool availability, media types,
access enforcement, limit enforcement, cancellation, and execution boundary.
A run is rejected before provider transport when a required property cannot be
provided.

### Safety terms describe actual enforcement

Restricting model-visible tools is not an operating-system sandbox. Receipts
must distinguish:

- tool-policy-only from OS-enforced filesystem access;
- shared-user from isolated process execution;
- enforced from unenforced network policy;
- backend-hard, host-abort, best-effort, and unsupported limits.

A sandboxed backend and a shared-user subprocess are useful for different
purposes and must not report equivalent guarantees.

### Sealing belongs to the runtime

The caller may provide source and provenance fingerprints. The runtime computes
the conversation fingerprint after host compilation, then computes the
execution fingerprint after binding the accepted backend and preflight. A
caller cannot supply or recompute substitute fingerprints to authorize a
changed plan.

The registry binds execution to the exact accepted backend, preflight,
conversation, tool mapping, access receipt, limits, and runtime inputs.
Equivalent conversations executed by different backends may have the same
conversation fingerprint but must have different execution fingerprints.

### Core contracts are Pi-version-light

Core contracts use portable data rather than Pi SDK objects. The core should
not expose `ExtensionContext`, `ModelRegistry`, `ModelRuntime`, `AgentSession`,
or provider credentials.

Pi-specific imports and version compatibility belong inside backend entry
points. A Pi SDK or RPC change should normally require updating a backend, not
the core contract or every host.

### Lifecycle is structured but not orchestrated

Executing a prepared plan returns a handle with events, cancellation, and one
terminal result. The core does not own batch scheduling, background job
persistence, chains, retries, or supervisor behavior. Hosts compose ordinary
runs as needed.

## Package architecture

The pre-alpha can remain one repository and npm package with isolated entry
points:

```text
@zihanw/pi-subagent-runtime
├── core                    portable contracts and validators
├── runtime                 registry, preparation, sealing, lifecycle
├── testing                 reusable backend conformance suite
├── backends/subprocess     fresh Pi child-process backend
└── backends/rpc            fresh Pi RPC child-process backend
```

`core`, `runtime`, and `testing` must contain no Pi SDK imports. Pi dependencies
are optional peers used only by backend entry points. Backends may be split
into separately versioned packages later if Pi compatibility creates release
pressure.

The initial process adapters share an adapter-private, Pi-SDK-backed
preparation component. That component owns the temporary `AgentSession`,
`before_agent_start` provider gate, and Pi runtime extraction needed for exact
host compilation. Its Pi version coupling remains confined to the backend
entry points.

There is deliberately no `pi` extension entry point in the initial release.

## Contract direction

Names remain provisional, but the public interaction should follow this shape:

```ts
interface ExecutionRuntime {
  prepare(request: PrepareRequest): Promise<PreparedRun>;
  execute(prepared: PreparedRun): RunHandle;
  registerBackend(backend: ExecutionBackend): Disposable;
  listBackends(): BackendDescriptor[];
  dispose(): Promise<void>;
}

interface PrepareRequest {
  backendId: string;
  intent: ExecutionIntent;
  compile(runtime: PromptRuntime): Promise<PreparedConversation>;
}

interface ExecutionIntent {
  model: ModelReference;
  thinkingLevel?: string;
  requestedTools: string[];
  access: AccessRequest;
  limits: LimitRequest;
  media?: MediaReference[];
  provenance?: Record<string, string>;
}

interface PreparedConversation {
  systemPrompt: string;
  messages: PreparedMessage[];
}

interface PreparedRun {
  id: string;
  backendId: string;
  conversationFingerprint: string;
  executionFingerprint: string;
  snapshot(): SealedPlanSnapshot;
  discard(): Promise<void>;
}

interface RunHandle {
  id: string;
  snapshot(): RunSnapshot;
  subscribe(listener: RunEventListener): Disposable;
  cancel(reason?: string): Promise<void>;
  result: Promise<RunResult>;
}
```

Important invariants:

- `PreparedRun` is produced only by the runtime after accepted preflight and
  host compilation.
- `conversationFingerprint` binds the exact system prompt and ordered messages.
- `executionFingerprint` is runtime-generated.
- `execute()` accepts the prepared handle bound to the creating runtime, not an
  arbitrary caller-constructed plan.
- The snapshot is inspectable for approval but cannot be used to execute a
  modified substitute.
- Preparation can be discarded without provider transport.
- All terminal paths settle once and complete backend cleanup.

Discard is the explicit path for an approval that is abandoned. Compiler or
preparation failure automatically invokes backend preparation cleanup.
Unregistering a backend prevents new preparations but does not invalidate
already-bound handles; those handles retain a backend lease until execution or
discard. Disposing the runtime rejects new work, discards outstanding
preparations, cancels active runs, and awaits backend cleanup.

A convenience API for already-compiled conversations may be added later, but
it must still perform backend preflight and runtime sealing.

## Backend contract

A backend is more than a process transport. It must implement the runtime's
preflight, preparation, execution, cancellation, cleanup, and receipt
semantics.

A provisional SPI is:

```ts
interface ExecutionBackend {
  readonly descriptor: BackendDescriptor;

  preflight(intent: ExecutionIntent): Promise<BackendPreflightResult>;

  prepare(
    input: AcceptedPreparationInput,
    context: {
      compile(runtime: PromptRuntime): Promise<PreparedConversation>;
      signal: AbortSignal;
    },
  ): Promise<BackendPreparation>;

  start(
    input: BoundExecutionInput,
    context: {
      emit(event: BackendRunEvent): void;
      signal: AbortSignal;
    },
  ): Promise<BackendExecution>;

  discard(preparation: BackendPreparation): Promise<void>;
}

interface BackendExecution {
  result: Promise<BackendResult>;
  cancel(reason?: string): Promise<void>;
  dispose(): Promise<void>;
}
```

`BackendPreparation` is backend-opaque state retained by the runtime-bound
prepared handle. `prepare()` is failure-atomic: if the compiler callback or
backend setup fails before it returns, the backend releases its partial
resources before rejecting. After it returns, the runtime validates the
compiler result before sealing it and invokes `discard()` if validation,
sealing, execution startup, or host approval does not complete.

The runtime passes the bound plan back to `start`. Backend events are
non-terminal; completion, failure, cancellation, timeout, and cleanup errors
compete through the runtime's exactly-once terminal arbiter. The runtime always
invokes `dispose()` after terminal settlement.

Likely backend families include:

- in-process Pi SDK;
- fresh Pi subprocess;
- fresh or managed Pi RPC process;
- sandboxed subprocess or RPC;
- container worker;
- remote Pi worker;
- deterministic fake backend for conformance tests.

The runtime does not infer that RPC, a worktree, or a tool allowlist is a
sandbox. Each backend advertises only the guarantees it can actually enforce.

## First reference backends

### Pi subprocess backend

The first backend is adapted from Pi Forge's existing
`pi-subprocess-readonly` implementation. It is a hybrid backend: an in-process
Pi SDK `AgentSession` and provider gate perform exact preparation, then a fresh
Pi child process performs execution. It is the baseline because it already
demonstrates:

- backend-assisted exact prompt preparation;
- runtime-bound immutable plans;
- a fresh Pi process with explicit model, thinking, and tool selection;
- a trusted bridge that installs the exact system prompt and ordered messages;
- disabled ambient extensions, skills, templates, themes, and context files;
- cancellation with bounded TERM-to-KILL escalation;
- bounded and sanitized reporting;
- honest `shared-user` enforcement receipts.

The initial extraction should preserve behavior before generalizing it.

### Pi RPC backend

RPC is a good second backend because Pi provides a documented JSONL protocol
for prompting, events, model and thinking control, abort, state, messages, and
usage.

For the first implementation:

- start a fresh `pi --mode rpc` process per execution;
- use `--no-session` and disable ambient resources;
- load only the trusted prepared-message bridge;
- send a unique marker prompt through RPC;
- have the bridge replace that marker with the sealed ordered messages before
  the first provider request;
- stream RPC lifecycle and tool events into runtime events;
- use RPC `abort`, followed by process termination if it does not settle;
- collect terminal output and usage through documented RPC commands/events;
- report a shared-user boundary unless the entire process is launched through
  a separate sandbox implementation.

The first RPC backend will not provide:

- process pooling or reuse;
- session resume, fork, clone, or durable history;
- steering or follow-up product behavior;
- dynamic system-prompt or tool changes after process launch;
- stronger filesystem or network guarantees than its process launcher
  enforces.

RPC simplifies execution control, but not exact compilation. Backend-assisted
preparation still requires the host compiler and, initially, the same
Pi-SDK-backed `AgentSession` provider gate as the subprocess backend. The first
spike must prove that the RPC bridge preserves the same conversation
fingerprint, system prompt, ordered messages, and effective tools as the
subprocess backend; their execution fingerprints are expected to differ. If
the spike finds a documented RPC-native source for the exact prompt runtime,
the SDK preparation dependency may be removed from that adapter. Otherwise it
remains an explicit, backend-local Pi version coupling. If exact fidelity
cannot be established, the RPC backend must advertise reduced fidelity and
reject incompatible plans.

## Safety model

A caller states required properties. A backend advertises capabilities during
preflight and returns actual enforcement receipts during execution.

The runtime rejects a run when:

- the explicitly requested backend is missing;
- a required access property cannot be enforced;
- the selected model, thinking level, media, or tool mapping cannot be
  provided faithfully;
- exact host preparation cannot finish before provider transport;
- an execution plan differs from the registry-bound sealed plan;
- a backend returns a receipt inconsistent with its accepted descriptor;
- a required hard limit is available only as host-abort or best-effort.

The runtime cannot detect every dishonest backend claim. Backend trust and
conformance evidence remain explicit caller concerns.

## Initial v0.1 scope

The first useful release contains:

1. versioned portable intent, prompt-runtime, prepared-message, plan, result,
   event, capability, and enforcement-receipt contracts;
2. canonical serialization and runtime-generated conversation and execution
   fingerprints;
3. backend registration and explicit backend lookup;
4. validated preflight and exact/backend-assisted host preparation;
5. sealed plan binding, inspection, discard, and execution;
6. run handles, event subscription, cancellation, terminal normalization, and
   cleanup;
7. reusable fake-backend conformance tests;
8. the adapted fresh subprocess backend;
9. a constrained fresh-process RPC backend after its fidelity spike passes;
10. Pi Forge migrated as the first host;
11. one independent API fixture that owns its own prompt without importing
    Forge concepts.

The independent fixture proves portability, not ecosystem demand. Publication
and stability still require a genuine second consumer or backend author.

## Explicit non-goals

The initial project does not own:

- a model-callable subagent tool or Pi command;
- bundled agent personas, prompt presets, or agent Markdown discovery;
- task-to-prompt construction or automatic parent-context inheritance;
- prompt-stack or profile management;
- model routing, backend fallback, or provider fallback;
- batch queues, background jobs, chains, DAGs, retries, or scheduling;
- persistent memory or durable sessions;
- worktree orchestration;
- inter-agent messaging, steering UX, or supervisor interviews;
- rich viewers, approval UI, or product-specific rendering;
- artifact stores or domain-specific result formats;
- a built-in sandbox or container manager.

These belong to hosts or separately versioned backend/companion packages.

## Relationship to Pi Forge

The runtime is extracted from the experimental adapter in
[`@zihanw/pi-forge`](https://github.com/MacroSony/pi-forge).

Pi Forge continues to own:

- profile and prompt-stack resolution;
- trusted macro and slot dependencies;
- selected-context compilation and protected task assembly;
- project trust, egress consent, and human approval;
- product UI and report rendering;
- Forge-specific provenance fingerprints.

The runtime owns the generic backend registry, execution fingerprint, binding,
lifecycle, and receipts. Forge compiles through the runtime's host callback,
inspects the sealed plan, authorizes it, and executes the prepared handle.

## First implementation sequence

### 0. Preserve the evidence

- Record the current Forge test baseline.
- Identify generic modules and Forge-specific modules before moving code.
- Copy tests with their implementation, then rename and generalize in small
  steps.
- Do not change Forge behavior during the initial extraction.

The initial extraction map is:

| Forge source | Initial treatment |
| --- | --- |
| `canonical.ts`, generic diagnostics, and pure validators | Adapt into `core` |
| portable portions of `types.ts` | Split into versioned `core` contracts |
| `backend-registry.ts`, preflight, plan binding, and response settlement | Adapt into `runtime` |
| fake backend and backend conformance tests | Adapt into `testing` first |
| `pi-subprocess-backend.ts`, `subprocess-bridge.ts`, and subprocess reporting | Adapt into `backends/subprocess` |
| `pi-sdk-backend.ts` and `pi-model-runtime.ts` | Keep as backend research; do not put Pi types in core |
| request/profile/context/task construction and tool resource policy | Leave in Forge |
| Forge commands, model-callable tool, approval, and rendering | Leave in Forge |

### 1. Extract the portable core

- Port canonical JSON, fingerprints, diagnostics, access and limit types,
  prepared messages, backend descriptors, results, and pure validators.
- Remove `AgentProfile`, `PromptStack`, Forge dependency receipts, and Pi SDK
  objects from the portable boundary.
- Replace caller-supplied execution fingerprints with runtime-generated ones.
- Add contract tests proving the core has no Pi package imports.

### 2. Extract the registry and lifecycle

- Port backend registration, preflight binding, backend-assisted preparation,
  plan binding, cancellation arbitration, and result normalization.
- Make backend ID mandatory during preparation.
- Return inspectable prepared handles and execution run handles.
- Make compiler/setup failure, discard, unregister, start failure, cancellation,
  and runtime disposal release their backend resources exactly once.
- Keep batching, queueing, persistence, and process-local global services out.

### 3. Port the subprocess backend

- Move the existing preparation and execution bridge with behavior-preserving
  tests.
- Generalize Forge names and report types.
- Preserve bounded output, cancellation draining, and shared-user receipts.
- Run the reusable backend conformance suite.

### 4. Spike and implement the RPC backend

- Build a minimal strict-LF JSONL RPC client.
- Launch a fresh hermetic RPC process.
- Reuse the adapter-private Pi SDK preparation component unless the spike proves
  an exact RPC-native replacement.
- Reuse the prepared-message bridge and marker replacement.
- Compare conversation fingerprints and prove exact prompt/message/tool
  fidelity before provider transport; expect backend-bound execution
  fingerprints to differ.
- Map settled events, usage, abort, process escalation, and cleanup.
- Reject unsupported plans rather than weakening them.

### 5. Migrate Pi Forge

- Replace Forge's private registry/backend ownership with the runtime package.
- Keep Forge compilation, approval, and UI unchanged.
- Compare plan fingerprints and terminal reports against the pre-extraction
  fixtures.
- Dogfood both subprocess and RPC backends without changing the user-facing
  Forge workflow.

### 6. Validate independence

- Add a small non-Forge host fixture with its own prompt compiler.
- Publish backend-author documentation and the conformance harness.
- Seek a genuine second consumer or backend before declaring the contract
  stable.

## First coding slice

The first implementation change should stop before launching a real Pi
process. It should:

1. scaffold the strict TypeScript package and public entry points;
2. adapt portable contracts, canonical serialization, fingerprints, and pure
   validation from Forge;
3. implement explicit backend registration, preparation, sealing, inspection,
   discard, and one-shot execution;
4. adapt the deterministic fake backend and the smallest conformance harness;
5. prove that an unregistered backend, incompatible intent, forged prepared
   handle, changed sealed plan, double execution, competing terminal causes,
   compiler/setup failure, abandoned preparation, unregister, and runtime
   disposal settle or clean up exactly once.

This slice establishes the boundary against a deterministic backend. The next
change ports the known-good subprocess implementation without redesigning it.
The RPC fidelity spike then becomes a second adapter over a stable contract
instead of defining the contract through RPC's current command set.

## v0.1 completion criteria

The first release is ready when:

- Pi Forge uses the public runtime without private integration hooks;
- the portable core imports no Pi SDK types;
- backend selection is explicit and no fallback occurs;
- both reference backends either preserve the same sealed conversation or
  reject unsupported fidelity before transport;
- required guarantees fail closed;
- receipts distinguish shared-user tool policy from OS enforcement;
- cancellation, timeout, malformed output, and provider failure settle once
  and clean up;
- the conformance suite can validate a backend outside Pi Forge;
- no user-facing tool, persona, workflow, queue, or UI has entered the core.

The project should pause before API stabilization if no second real consumer or
backend author needs the boundary. Pi Forge alone proves feasibility, not an
ecosystem.
