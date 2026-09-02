# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Added

- Add the `pi-inprocess` backend: preparation primes a real AgentSession
  against the host model runtime and execution resumes that session in place,
  so extension-registered providers (OAuth, custom `streamSimple`, account
  pools) work unchanged. Access is enforced by the session tool allowlist
  only — a same-process policy boundary with no OS isolation, reported
  honestly in the access receipt.
- `SdkPreparationGate.take()` hands a primed preparation to in-process
  backends without disposing it, and `executablePreparations` seeds the
  compiled conversation once instead of pinning every turn.

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
