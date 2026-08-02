# Changelog

All notable changes to this project will be documented in this file.

## [0.1.0-beta.2] - Unreleased

### Changed

- Pi core packages are now wildcard optional peers supplied by the running host; exact Pi versions remain development-only fixtures.
- The reproducible development baseline now targets Pi 0.83.0.
- Process backends accept the minimal structural model-registry surface they use instead of branding consumers with the development Pi version's private `ModelRegistry` fields.

### Fixed

- Process-backend preparation now reports missing authenticated model-runtime capabilities without hard-coding a single supported Pi version, and still permits hosts to pass an explicit compatible `ModelRuntime`.

## [0.1.0-beta.1] - 2026-07-28

- Published the initial execution kernel, portable contracts, lifecycle runtime, reusable conformance suite, and subprocess/RPC backends.
