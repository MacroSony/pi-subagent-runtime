# Pi Subagent Runtime

> An API-first, policy-aware runtime for spawning prepared Pi agents.

**Status:** Pre-alpha. The public contract is being designed and the package is
not yet published.

Pi Subagent Runtime is a small execution layer for
[Pi](https://github.com/earendil-works/pi) subagents. It provides useful
defaults for direct use while remaining open to profile managers, review
tools, workflow engines, sandbox providers, and other Pi extensions.

## Why?

Existing Pi subagent packages often combine execution with named agents,
prompt construction, workflow orchestration, memory, scheduling, or UI. Those
features are useful when one package owns the complete subagent experience,
but they make the execution layer harder for another extension to reuse.

Pi Subagent Runtime targets a lower-level boundary:

> Run a caller-prepared Pi agent without taking ownership of its prompt,
> profile, policy, workflow, or UI.

## What it provides

- exact prepared system prompts and ordered messages;
- foreground and session-scoped background runs;
- bounded parallel execution and queuing;
- cancellation, timeouts, limits, and bounded output;
- backend capability negotiation before execution;
- enforcement receipts describing the boundary actually provided;
- pluggable in-process, subprocess, sandbox, container, or remote backends;
- a typed API for other Pi extensions;
- a thin optional Pi extension for direct users.

The runtime uses conservative defaults, but it does not describe tool
restriction as an operating-system sandbox. Unsupported required guarantees
are rejected rather than silently weakened.

## What it does not own

- bundled agent personas or prompt presets;
- prompt-stack or profile management;
- workflow chains, DAGs, scheduling, or persistent memory;
- model routing and fallback policy;
- worktree orchestration or inter-agent messaging;
- product-specific session viewers and UI.

These belong to callers or optional companion packages.

## API direction

All runs return asynchronous handles. Foreground execution awaits the result;
background execution retains the handle and continues. Parallel fan-out uses
the same bounded queue rather than a separate workflow engine.

```ts
import {
  createSubagentRuntime,
  PiSubprocessBackend,
} from "@zihanw/pi-subagent-runtime";

const runtime = createSubagentRuntime({
  maxConcurrent: 4,
  backends: [new PiSubprocessBackend()],
});

const handle = runtime.spawn({
  kind: "prepared",
  systemPrompt: "You are reviewing a TypeScript library.",
  messages: [
    {
      role: "user",
      content: [{ type: "text", text: "Review the cancellation logic." }],
    },
  ],
  model: { provider: "anthropic", id: "claude-sonnet-4-5" },
  tools: ["read", "grep", "find", "ls"],
  access: { level: "read-only", network: "allow" },
  limits: { timeoutMs: 60_000 },
});

const result = await handle.result;
console.log(result.output);
console.log(result.enforcement);
```

The API is illustrative and may change during the pre-alpha.

## Architecture and roadmap

See [VISION.md](./VISION.md) for the design principles, safety model, proposed
contracts, extension points, initial scope, explicit non-goals, and staged
roadmap.

## Relationship to Pi Forge

The runtime is being incubated from the experimental subagent adapter in
[`@zihanw/pi-forge`](https://github.com/MacroSony/pi-forge). Pi Forge will own
profile resolution, prompt-stack compilation, and policy; it will hand the
runtime a sealed prepared plan and verify the returned enforcement receipt.

Pi Forge is the first consumer, not a required dependency.
