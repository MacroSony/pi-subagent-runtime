# Independent Host Example

`mini-host.ts` is the smallest complete host for `@zihanw/pi-subagent-runtime`.
It proves the adoption path works from the published package surface alone:
imports resolve through the package name (no source-relative paths, no
pi-forge modules, no Pi host singletons), and the same host-owned plan runs
on both process backends with visible receipt parity.

Two test suites drive this exact file, so the example cannot drift:

- `tests/independent-host.test.ts` — deterministic scripted children:
  plan parity, approval integrity, execution parity, receipt/report parity,
  rejection, and cancellation.
- `tests/independent-host.e2e.test.ts` — real `pi` children in text and RPC
  modes against a local mock provider (skipped when no pi CLI is installed).

## The host flow

```ts
import { MiniHost } from "./mini-host.ts";
import { PiSubprocessBackend } from "@zihanw/pi-subagent-runtime/backends/subprocess";
import { PiRpcBackend } from "@zihanw/pi-subagent-runtime/backends/rpc";

// 1. Construct backends with your own ModelRegistry and working directory.
const subprocess = new PiSubprocessBackend({ modelRegistry, cwd });
const rpc = new PiRpcBackend({ modelRegistry, cwd });

// 2. The host registers every backend it is willing to offer.
const host = new MiniHost([subprocess, rpc]);

// 3. Compile + seal a plan for one task. Nothing executes.
const approved = await host.prepare(profile, task, rpc.descriptor.id);

// 4. Approval gate: inspect the sealed snapshot (system prompt, ordered
//    messages, effective tools, model, fingerprints) and verify integrity.
if (!host.verifyApproval(approved.plan)) throw new Error("tampered plan");
//    ... show approved.plan to a human or policy engine here ...

// 5a. Execute an approved plan; cancel through the handle.
const handle = host.start(approved);
const result = await handle.result;

// 5b. Or reject it: discard releases the preparation and makes execution
//     impossible.
await host.discard(approved);

await host.dispose();
```

## What the host owns vs. what the runtime owns

| Host (you) | Runtime |
| --- | --- |
| Profile format and policy (`MiniProfile`, `intentFor`) | Intent/preflight validation |
| Prompt compilation (`#compile`) | Plan sealing and fingerprints |
| Approval decision (`verifyApproval` + your UI) | Backend binding of the sealed plan |
| Start/discard/cancel decisions | Lifecycle, exactly-once settlement |
| Receipt comparison (`receiptKey`) | Honest enforcement receipts |

## Cross-backend parity

Because sealing is deterministic, preparing the same intent and conversation
on both backends yields:

- equal `conversationFingerprint` and equal host-owned plan core
  (`host.planCoreKey` — schema, intent, conversation, effective tools);
- different `executionFingerprint` values (the fingerprint binds the plan to
  one backend — a plan sealed for subprocess cannot execute on RPC);
- equal canonical enforcement receipts after execution (`host.receiptKey`).

## Adopting this in your own extension

1. Add `@zihanw/pi-subagent-runtime` as a dependency and construct the
   backends you trust (both shipped backends need a `ModelRegistry` from
   `pi-coding-agent` and accept an `invocationFactory` override for tests).
2. Copy `mini-host.ts` and replace `MiniProfile`, `intentFor`, and
   `#compile` with your own profile format, policy, and prompt compiler.
3. Keep the discipline: never execute an unapproved plan, never mutate a
   sealed snapshot, and treat receipts as the only enforcement truth.
