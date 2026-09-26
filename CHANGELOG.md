# Changelog

All notable changes to this project will be documented in this file.

## Unreleased

- Add opt-in, bounded, same-process in-memory continuation on the in-process
  backend only. Fresh preflight/approval seals the full original context plus
  one new task; original SDK session/tool history is retained without summaries.
  Model/tools/prompt/access binding changes require a new child. Other backends
  reject continuation explicitly. Automatic compaction is disabled for retained
  children using an in-memory override, not user settings writes.
- Add explicit continuation release, prepare/discard reservations, and runtime-
  owned backend cleanup. Retained contexts expire with their runtime instance;
  there is no disk recovery or cross-session fork. Failed cleanup is retryable,
  and cancellation races release otherwise-unreachable retained children.

- Preserve optional cache-token breakdown, native cost components and receipt
  coverage in `RunUsage`. Legacy/custom summaries remain valid; incomplete
  coverage must not be promoted to complete Pi usage. See `RUNTIME-USAGE.md`.
- Preserve validated partial usage when the host cancels/times out execution or
  cleanup fails, without overriding host-owned status or enforcement.

## [0.1.0-beta.4] - 2026-09-03

### Added

- Add the `pi-inprocess` backend: preparation primes a real AgentSession
  against the host model runtime and execution resumes that session in place,
  so extension-registered providers (OAuth, custom `streamSimple`, account
  pools) work unchanged. Access is enforced by the session tool allowlist
  only — a same-process policy boundary with no OS isolation, reported
  honestly in the access receipt.
- `SdkPreparationGate.take()` hands a primed preparation to in-process
  backends without disposing it; `executablePreparations` splices the
  compiled conversation over the preparation trigger on every provider
  request, so multi-turn runs keep the sealed conversation alongside
  accumulated tool results.

### Fixed

- Block provider transport in the stream path itself: the Pi event runner
  swallows extension-hook errors, so a rejected preparation gate alone could
  not stop a provider call.
- Track in-flight preparations so dispose cannot orphan a session, and refuse
  new preparations after `stopAll()` so disposal cannot be raced.
- Bound cancellation, disposal, and gate cleanup so a provider that ignores
  abort cannot hang the run result or the backend.
- Set run-report `finishedAt`, clean up preparations taken by an in-process
  run whose setup fails, and check tool effects at preflight so accepted
  preflights survive core validation.

### Changed

- Scope the workspace-write and process isolation requirements to the
  `isolated` execution boundary. A `shared-user` backend may now accept
  workspace-write and process access with all isolation enforcement flags
  honestly false; isolated receipts remain required to claim containment.

## [0.1.0-beta.3] - 2026-08-30

### Added

- Add the Linux `pi-bwrap-write` backend for direct, sandbox-contained workspace
  edits with explicit static/selected-model child authentication, git work-tree
  preflight, dirty-tree diagnostics, and read-only top-level git metadata.
- Run both Bubblewrap backends through the reusable conformance suite.

### Changed

- Recommend the simpler write-through-plus-git path for interactive hosts while
  retaining `pi-bwrap-propose-write` as an experimental unattended-workflow lane.

## [0.1.0-beta.2]

### Changed

- Pi core packages are now wildcard optional peers supplied by the running host; exact Pi versions remain development-only fixtures.
- The reproducible development baseline now targets Pi 0.83.0.
- Process backends accept the minimal structural model-registry surface they use instead of branding consumers with the development Pi version's private `ModelRegistry` fields.

### Fixed

- Process-backend preparation now reports missing authenticated model-runtime capabilities without hard-coding a single supported Pi version, and still permits hosts to pass an explicit compatible `ModelRuntime`.

## [0.1.0-beta.1] - 2026-07-28

- Published the initial execution kernel, portable contracts, lifecycle runtime, reusable conformance suite, and subprocess/RPC backends.
