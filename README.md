# Pi Subagent Runtime

> A pure execution kernel for caller-prepared Pi agents.

**Status:** Experimental prerelease. The API may change before v0.1.0.

Pi Subagent Runtime lets another extension or application execute an exact,
caller-compiled Pi conversation through an explicitly selected backend.

It does not discover agents, construct task prompts, choose a backend, register
a model-callable tool, or own workflows and UI.

## The boundary

```text
Pi Forge / review tool / workflow engine / custom host
        owns prompts, policy, approval, orchestration, UI
                              |
                              v
                 Pi Subagent Runtime
        owns preflight, preparation mediation, sealing,
               lifecycle, cancellation, receipts
                              |
                              v
             subprocess / RPC / sandbox / remote backend
```

The project targets a narrower gap than a general subagent package:

> Execute a caller-compiled, ordered Pi conversation without reinterpreting it,
> silently weakening its requirements, or overstating the enforced boundary.

## What the runtime provides

- portable execution-intent and prepared-message contracts;
- explicit backend registration and selection;
- capability negotiation before provider transport;
- exact or backend-assisted host compilation;
- runtime-generated conversation and execution fingerprints with sealed-plan
  binding;
- inspectable prepared plans for host-owned approval;
- evented run handles, cancellation, cleanup, and terminal results;
- enforcement receipts that distinguish tool policy from OS isolation;
- reusable backend conformance tests.

An enforcement receipt is a backend attestation. The runtime validates
consistency, but callers remain responsible for trusting backend
implementations.

## What it does not provide

- a `subagent` tool or Pi command;
- agent personas, Markdown discovery, or prompt defaults;
- task-to-prompt construction or context inheritance;
- model routing or backend fallback;
- batch queues, background jobs, workflows, retries, or scheduling;
- worktree, sandbox, container, or remote policy;
- approval UI, viewers, persistence, or product-specific artifacts.

Hosts and separately versioned backends may provide those features.

## Installation

Install the current prerelease by its exact version in production integrations:

```sh
npm install @zihanw/pi-subagent-runtime@0.1.0-beta.1
```

The portable `core`, `runtime`, and `testing` entry points contain no Pi SDK
imports. The process-backend entry points use the compatible optional Pi peer
dependencies supplied by their host.

## API overview

Preparation is two-phase because some exact Pi prompt inputs are available only
inside the backend's prompt lifecycle:

```ts
import { createExecutionRuntime } from "@zihanw/pi-subagent-runtime";
import { PiRpcBackend } from "@zihanw/pi-subagent-runtime/backends/rpc";

const runtime = createExecutionRuntime();
runtime.registerBackend(new PiRpcBackend());
const preparationController = new AbortController();

const prepared = await runtime.prepare({
  backendId: "pi-rpc",
  signal: preparationController.signal,
  intent: {
    model: { provider: "example", id: "review-model" },
    requestedTools: ["read", "grep", "find", "ls"],
    access: {
      level: "read-only",
      executionBoundary: "shared-user",
      workspaces: [{ handle: "workspace", mode: "read-only" }],
      network: "allow",
    },
    limits: { timeoutMs: { value: 60_000, enforcement: "best-effort" } },
  },
  compile: async (promptRuntime, acceptedPreflight) => ({
    systemPrompt: compileOwnedSystemPrompt({
      promptRuntime,
      toolCatalog: acceptedPreflight.toolCatalog,
    }),
    messages: compileOwnedMessages(),
  }),
});

// The host may inspect prepared.snapshot() and obtain approval here.
const run = runtime.execute(prepared);
const result = await run.result;
```

The API is experimental and may change before v0.1.0. Its important invariants
are:

- the host owns compilation;
- the host compiler receives a cloned, validated accepted preflight;
- the backend is selected explicitly;
- the runtime computes and binds the execution fingerprint;
- faithful materialization of the compiled conversation is a required backend
  invariant tested by the conformance suite;
- unsupported guarantees are rejected before provider transport.

The optional preparation signal covers preflight and backend-assisted
preparation only. The runtime relays it to the backend, removes its listener
when `prepare()` settles, and does not let a later abort control an already
prepared run. Execution cancellation remains explicit through
`RunHandle.cancel()`.

The runtime can detect mutation of its sealed plan and inconsistent receipts.
It cannot prove that a malicious backend sent the same content to a provider,
so backend trust remains explicit.

## First backends

The first backend, available at
`@zihanw/pi-subagent-runtime/backends/subprocess`, adapts Pi Forge's hybrid
implementation: Pi-SDK-backed preparation behind a provider gate, followed by
execution in a fresh Pi subprocess through the trusted prepared-message
bridge. It preserves bounded sanitized reporting, cancellation draining with
TERM-to-KILL escalation, and honest `shared-user` enforcement receipts.

The second backend, available at
`@zihanw/pi-subagent-runtime/backends/rpc`, launches a fresh `pi --mode rpc`
process per execution. It uses Pi's documented strict-LF JSONL protocol for
the marker prompt, lifecycle events, abort, and settlement, while sharing the
same SDK-backed preparation gate and the same trusted prepared-message bridge
as the subprocess backend. Both backends seal the identical compiled
conversation (equal conversation fingerprints) with distinct backend-bound
execution fingerprints. RPC process reuse, resume, fork, steering, and durable
sessions remain outside the initial scope.

Cancellation uses the documented RPC `abort` command first and escalates to
bounded TERM-to-KILL process termination when the run does not settle.

Both initial process backends report a shared-user boundary unless a separate
sandbox implementation launches the entire process under stronger
enforcement.

## Host independence

The runtime works from its published package surface alone.
[`examples/independent-host/`](./examples/independent-host/) contains a
complete minimal host — its own profile format, prompt compiler, approval
gate, and cancellation — driving both process backends with plan, receipt,
and report parity. The example is exercised directly by
`tests/independent-host.test.ts` (scripted children) and
`tests/independent-host.e2e.test.ts` (real `pi` children when a CLI is
available), so it cannot drift from the shipped API.

## Architecture and implementation plan

See [VISION.md](./VISION.md) for ownership boundaries, contract direction,
backend semantics, safety terminology, the first implementation sequence, and
v0.1 completion criteria.

## Relationship to Pi Forge

The runtime was extracted from the experimental subagent adapter in
[`@zihanw/pi-forge`](https://github.com/MacroSony/pi-forge).

Pi Forge remains responsible for profiles, prompt stacks, trusted compiler
extensions, project trust, approval, and UI. It compiles through the runtime,
inspects the sealed plan, and executes it through an explicitly selected
backend.
