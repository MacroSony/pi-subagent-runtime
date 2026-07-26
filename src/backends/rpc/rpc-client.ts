import { StringDecoder } from "node:string_decoder";
import type { ChildProcess } from "node:child_process";

export interface PiRpcResponse {
  type: "response";
  command: string;
  success: boolean;
  id?: string;
  error?: string;
  data?: unknown;
}

export interface PiRpcRecord {
  type: string;
  [key: string]: unknown;
}

export interface PiRpcClientHandlers {
  /** Called for every non-response record on stdout. */
  onEvent(record: PiRpcRecord): void;
  /** Called when stdout emits a line that is not valid JSON. */
  onProtocolError(message: string): void;
}

export interface PiRpcClientOptions {
  /** Maximum bytes retained per pending response/error description. */
  maxLineBytes?: number;
}

const DEFAULT_MAX_LINE_BYTES = 16 * 1024 * 1024;

/**
 * Minimal strict-LF JSONL client for Pi's RPC mode.
 *
 * Pi frames records with LF (`\n`) as the only delimiter; a trailing `\r`
 * is stripped. Node's readline is deliberately not used because it also
 * splits on U+2028/U+2029, which are valid inside JSON strings.
 */
export class PiRpcClient {
  readonly #child: ChildProcess;
  readonly #handlers: PiRpcClientHandlers;
  readonly #maxLineBytes: number;
  readonly #pending = new Map<
    string,
    { resolve(response: PiRpcResponse): void; command: string }
  >();
  #buffer = "";
  #decoder = new StringDecoder("utf8");
  #counter = 0;
  #closed = false;

  constructor(child: ChildProcess, handlers: PiRpcClientHandlers, options: PiRpcClientOptions = {}) {
    this.#child = child;
    this.#handlers = handlers;
    this.#maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
    const stdout = child.stdout;
    if (!stdout) {
      handlers.onProtocolError("Pi RPC stdout channel was unavailable.");
      return;
    }
    stdout.on("data", (chunk: Buffer) => this.#ingest(this.#decoder.write(chunk)));
    stdout.on("end", () => {
      this.#ingest(this.#decoder.end());
      if (this.#buffer.trim()) this.#line(this.#buffer);
      this.#buffer = "";
      this.#failPending("Pi RPC stdout closed before a response arrived.");
    });
  }

  /** Sends a command and waits for its id-correlated response. */
  request(command: Record<string, unknown> & { type: string }): Promise<PiRpcResponse> {
    if (this.#closed) {
      return Promise.resolve({
        type: "response",
        command: command.type,
        success: false,
        error: "Pi RPC client is closed.",
      });
    }
    const id = `rpc-${++this.#counter}`;
    const payload = { ...command, id };
    return new Promise<PiRpcResponse>((resolve) => {
      this.#pending.set(id, { resolve, command: command.type });
      this.#write(payload, (error) => {
        if (!error) return;
        this.#pending.delete(id);
        resolve({
          type: "response",
          command: command.type,
          success: false,
          error: `Pi RPC command could not be written: ${error.message}`,
        });
      });
    });
  }

  /** Number of commands still awaiting a correlated response. */
  get pendingCount(): number {
    return this.#pending.size;
  }

  /** Closes the command channel; pending responses fail. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    try {
      this.#child.stdin?.end();
    } catch {
      // The child may already be gone.
    }
    this.#failPending("Pi RPC client closed before a response arrived.");
  }

  #ingest(text: string): void {
    this.#buffer += text;
    let index: number;
    while ((index = this.#buffer.indexOf("\n")) !== -1) {
      let line = this.#buffer.slice(0, index);
      this.#buffer = this.#buffer.slice(index + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      this.#line(line);
    }
    if (Buffer.byteLength(this.#buffer, "utf8") > this.#maxLineBytes) {
      this.#handlers.onProtocolError(
        `Pi RPC record exceeded ${this.#maxLineBytes} bytes.`,
      );
      this.#buffer = "";
    }
  }

  #line(line: string): void {
    if (!line.trim()) return;
    let record: PiRpcRecord;
    try {
      record = JSON.parse(line) as PiRpcRecord;
    } catch {
      this.#handlers.onProtocolError(
        "Pi RPC emitted a malformed JSON line.",
      );
      return;
    }
    if (record.type === "response") {
      const response = record as unknown as PiRpcResponse;
      const id = typeof response.id === "string" ? response.id : undefined;
      const pending = id ? this.#pending.get(id) : undefined;
      if (pending) {
        this.#pending.delete(id!);
        pending.resolve(response);
      }
      // Uncorrelated responses are ignored; events carry the stream.
      return;
    }
    this.#handlers.onEvent(record);
  }

  #write(payload: unknown, callback: (error: Error | null) => void): void {
    const stdin = this.#child.stdin;
    if (!stdin || stdin.destroyed) {
      callback(new Error("Pi RPC stdin channel was unavailable."));
      return;
    }
    stdin.write(`${JSON.stringify(payload)}\n`, (error) =>
      callback(error ?? null),
    );
  }

  #failPending(message: string): void {
    for (const [id, pending] of [...this.#pending.entries()]) {
      this.#pending.delete(id);
      pending.resolve({
        type: "response",
        command: pending.command,
        success: false,
        error: message,
      });
    }
  }
}
