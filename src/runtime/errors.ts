import type { Diagnostic } from "../core/index.ts";

export class ExecutionRuntimeError extends Error {
  readonly code: string;
  readonly diagnostics: readonly Diagnostic[];

  constructor(
    code: string,
    message: string,
    diagnostics: readonly Diagnostic[] = [],
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ExecutionRuntimeError";
    this.code = code;
    this.diagnostics = structuredClone(diagnostics);
  }
}
