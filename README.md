# Pi Subagent Runtime

> A pure execution kernel for caller-prepared Pi agents.

**Status:** Pre-alpha. The contract and first reference backends are being
extracted from Pi Forge. The package is not yet published.

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

## API direction

Preparation is two-phase because some exact Pi prompt inputs are available only
inside the backend's prompt lifecycle:

```ts
import { createExecutionRuntime } from "@zihanw/pi-subagent-runtime";
import { PiRpcBackend } from "@zihanw/pi-subagent-runtime/backends/rpc";

const runtime = createExecutionRuntime();
runtime.registerBackend(new PiRpcBackend());

const prepared = await runtime.prepare({
  backendId: "pi-rpc",
  intent: {
    model: { provider: "example", id: "review-model" },
    requestedTools: ["read", "grep", "find", "ls"],
    access: { level: "read-only", network: "allow" },
    limits: { timeoutMs: { value: 60_000, enforcement: "best-effort" } },
  },
  compile: async (promptRuntime) => ({
    systemPrompt: compileOwnedSystemPrompt(promptRuntime),
    messages: compileOwnedMessages(),
  }),
});

// The host may inspect prepared.snapshot() and obtain approval here.
const run = runtime.execute(prepared);
const result = await run.result;
```

The API is illustrative and will change during extraction. The important
invariants are:

- the host owns compilation;
- the backend is selected explicitly;
- the runtime computes and binds the execution fingerprint;
- faithful materialization of the compiled conversation is a required backend
  invariant tested by the conformance suite;
- unsupported guarantees are rejected before provider transport.

The runtime can detect mutation of its sealed plan and inconsistent receipts.
It cannot prove that a malicious backend sent the same content to a provider,
so backend trust remains explicit.

## First backends

The first backend will adapt Pi Forge's existing hybrid implementation:
Pi-SDK-backed preparation followed by execution in a fresh Pi subprocess.

A fresh-process Pi RPC backend follows as the second adapter. It will use Pi's
documented JSONL protocol for events, abort, state, and usage, while reusing the
same SDK-backed preparation gate and trusted prepared-message bridge to install
the sealed ordered conversation. RPC process reuse, resume, fork, steering, and
durable sessions are outside the initial scope.

Both initial process backends report a shared-user boundary unless a separate
sandbox implementation launches the entire process under stronger
enforcement.

## Architecture and implementation plan

See [VISION.md](./VISION.md) for ownership boundaries, contract direction,
backend semantics, safety terminology, the first implementation sequence, and
v0.1 completion criteria.

## Relationship to Pi Forge

The runtime is being extracted from the experimental subagent adapter in
[`@zihanw/pi-forge`](https://github.com/MacroSony/pi-forge).

Pi Forge remains responsible for profiles, prompt stacks, trusted compiler
extensions, project trust, approval, and UI. It compiles through the runtime,
inspects the sealed plan, and executes it through an explicitly selected
backend.
