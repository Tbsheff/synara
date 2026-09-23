import {
  JSONRPC_STDIO_MAX_FRAME_BYTES,
  JSONRPC_STDIO_MAX_QUEUED_STDIN_BYTES,
  JsonRpcStdioTransportError,
  JsonRpcStdioWriter,
  type JsonRpcStdioTransportErrorReason,
} from "@synara/shared/jsonrpc-stdio";

export const CODEX_APP_SERVER_MAX_STDOUT_FRAME_BYTES = 64 * 1024 * 1024;
export const CODEX_APP_SERVER_OVERSIZED_FRAME_PREFIX_BYTES = 8 * 1024;
export const CODEX_APP_SERVER_MAX_STDIN_FRAME_BYTES = JSONRPC_STDIO_MAX_FRAME_BYTES;
export const CODEX_APP_SERVER_MAX_QUEUED_STDIN_BYTES = JSONRPC_STDIO_MAX_QUEUED_STDIN_BYTES;
export const CODEX_APP_SERVER_MAX_FRAME_BYTES = CODEX_APP_SERVER_MAX_STDOUT_FRAME_BYTES;

export type CodexOversizedFramePayloadKey = "result" | "error" | "params";

export type CodexOversizedJsonlFrame = {
  readonly kind: "oversized";
  readonly maxBytes: number;
  readonly observedBytes: number;
  readonly id?: string | number;
  readonly method?: string;
  readonly payloadKey?: CodexOversizedFramePayloadKey;
};

export type CodexJsonlFrame = string | CodexOversizedJsonlFrame;

type DiscardedFrame = {
  prefix: Buffer;
  observedBytes: number;
};

export type CodexAppServerTransportErrorReason = JsonRpcStdioTransportErrorReason;

type CodexTransportErrorInput = {
  readonly reason: CodexAppServerTransportErrorReason;
  readonly maxBytes: number;
  readonly observedBytes: number;
  readonly cause?: unknown;
};

export class CodexAppServerTransportError extends JsonRpcStdioTransportError {
  constructor(input: CodexTransportErrorInput) {
    super({ ...input, message: transportErrorMessage(input) });
    this.name = "CodexAppServerTransportError";
  }
}

/**
 * Raw-byte JSONL framing that reports oversized Codex frames without ending
 * the session. The bounded prefix identifies the affected request while the
 * rest of the line is discarded.
 */
export class CodexJsonlFramer {
  private readonly chunks: Buffer[] = [];
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });
  private frameBytes = 0;
  private discarded: DiscardedFrame | undefined;
  private ended = false;

  constructor(
    readonly maxFrameBytes = CODEX_APP_SERVER_MAX_STDOUT_FRAME_BYTES,
    readonly maxDiscardPrefixBytes = CODEX_APP_SERVER_OVERSIZED_FRAME_PREFIX_BYTES,
  ) {
    if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes <= 0) {
      throw new RangeError("Codex JSONL frame budget must be a positive safe integer");
    }
    if (!Number.isSafeInteger(maxDiscardPrefixBytes) || maxDiscardPrefixBytes <= 0) {
      throw new RangeError("Codex JSONL discard prefix budget must be a positive safe integer");
    }
  }

  push(chunk: Buffer | Uint8Array | string): ReadonlyArray<CodexJsonlFrame> {
    if (this.ended) {
      throw new CodexAppServerTransportError({
        reason: "unterminated-frame",
        maxBytes: this.maxFrameBytes,
        observedBytes: this.frameBytes,
      });
    }

    const bytes =
      typeof chunk === "string"
        ? Buffer.from(chunk)
        : Buffer.isBuffer(chunk)
          ? chunk
          : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    const frames: CodexJsonlFrame[] = [];
    let start = 0;

    while (start < bytes.length) {
      const newline = bytes.indexOf(0x0a, start);
      const end = newline === -1 ? bytes.length : newline;
      this.append(bytes.subarray(start, end));
      if (newline === -1) break;
      frames.push(this.takeFrame());
      start = newline + 1;
    }

    return frames;
  }

  finish(): CodexOversizedJsonlFrame | undefined {
    this.ended = true;
    if (this.discarded) {
      return this.takeDiscardedFrame(this.discarded);
    }
    if (this.frameBytes > 0) {
      throw new CodexAppServerTransportError({
        reason: "unterminated-frame",
        maxBytes: this.maxFrameBytes,
        observedBytes: this.frameBytes,
      });
    }
    return undefined;
  }

  close(): void {
    this.chunks.length = 0;
    this.frameBytes = 0;
    this.discarded = undefined;
    this.ended = true;
  }

  get bufferedBytes(): number {
    return this.discarded ? this.discarded.prefix.length : this.frameBytes;
  }

  private append(chunk: Buffer): void {
    if (chunk.length === 0) return;
    if (this.discarded) {
      if (this.discarded.prefix.length < this.maxDiscardPrefixBytes) {
        this.discarded.prefix = this.extendDiscardPrefix([this.discarded.prefix, chunk]);
      }
      this.discarded.observedBytes += chunk.length;
      return;
    }
    const observedBytes = this.frameBytes + chunk.length;
    if (observedBytes > this.maxFrameBytes) {
      this.discarded = {
        prefix: this.extendDiscardPrefix([...this.chunks, chunk]),
        observedBytes,
      };
      this.chunks.length = 0;
      this.frameBytes = 0;
      return;
    }
    this.chunks.push(Buffer.from(chunk));
    this.frameBytes = observedBytes;
  }

  private extendDiscardPrefix(parts: ReadonlyArray<Buffer>): Buffer {
    const availableBytes = parts.reduce((total, part) => total + part.length, 0);
    return Buffer.concat(parts, Math.min(availableBytes, this.maxDiscardPrefixBytes));
  }

  private takeDiscardedFrame(discarded: DiscardedFrame): CodexOversizedJsonlFrame {
    this.discarded = undefined;
    const head = readOversizedFrameHead(discarded.prefix.toString("utf8"));
    return {
      kind: "oversized",
      maxBytes: this.maxFrameBytes,
      observedBytes: discarded.observedBytes,
      ...head,
    };
  }

  private takeFrame(): CodexJsonlFrame {
    if (this.discarded) {
      return this.takeDiscardedFrame(this.discarded);
    }
    let frame = Buffer.concat(this.chunks, this.frameBytes);
    if (frame.at(-1) === 0x0d) frame = frame.subarray(0, -1);
    this.chunks.length = 0;
    this.frameBytes = 0;
    try {
      return this.decoder.decode(frame);
    } catch (cause) {
      throw new CodexAppServerTransportError({
        reason: "invalid-utf8",
        maxBytes: this.maxFrameBytes,
        observedBytes: frame.length,
        cause,
      });
    }
  }
}

/** Codex-compatible name for the shared bounded, drain-aware JSONL writer. */
export class CodexJsonlWriter extends JsonRpcStdioWriter {
  constructor(
    writable: ConstructorParameters<typeof JsonRpcStdioWriter>[0],
    maxFrameBytes = CODEX_APP_SERVER_MAX_STDIN_FRAME_BYTES,
    maxQueuedBytes = CODEX_APP_SERVER_MAX_QUEUED_STDIN_BYTES,
  ) {
    super(writable, maxFrameBytes, maxQueuedBytes);
  }

  protected override makeTransportError(
    input: CodexTransportErrorInput,
  ): CodexAppServerTransportError {
    return new CodexAppServerTransportError(input);
  }

  protected override serializationError(cause?: unknown): Error {
    if (cause instanceof Error) return cause;
    if (cause !== undefined) return new Error(String(cause));
    return new TypeError("Codex app-server message is not JSON serializable");
  }

  protected override stdinClosedDuringWriteError(): Error {
    return new Error("Codex app-server stdin closed during write");
  }

  protected override stdinWriteAbortedError(): Error {
    return new Error("Codex app-server stdin write aborted");
  }
}

type OversizedFrameHead = {
  id?: string | number;
  method?: string;
  payloadKey?: CodexOversizedFramePayloadKey;
};

const JSON_WHITESPACE = new Set([" ", "\t", "\n", "\r"]);
const JSON_RPC_PAYLOAD_KEYS: ReadonlySet<string> = new Set(["result", "error", "params"]);

function readOversizedFrameHead(prefix: string): OversizedFrameHead {
  const head: OversizedFrameHead = {};
  let index = skipJsonWhitespace(prefix, 0);
  if (prefix[index] !== "{") return head;
  index = skipJsonWhitespace(prefix, index + 1);

  while (prefix[index] === '"') {
    const keyEnd = findJsonStringEnd(prefix, index);
    const key = keyEnd === undefined ? undefined : parseJsonString(prefix.slice(index, keyEnd));
    if (keyEnd === undefined || key === undefined) return head;
    index = skipJsonWhitespace(prefix, keyEnd);
    if (prefix[index] !== ":") return head;
    index = skipJsonWhitespace(prefix, index + 1);

    if (JSON_RPC_PAYLOAD_KEYS.has(key)) {
      head.payloadKey = key as CodexOversizedFramePayloadKey;
      return head;
    }
    const valueEnd = findJsonValueEnd(prefix, index);
    if (valueEnd === undefined) return head;
    const rawValue = prefix.slice(index, valueEnd).trim();
    if (key === "id") {
      const id = parseJsonRpcId(rawValue);
      if (id !== undefined) head.id = id;
    } else if (key === "method") {
      const method = parseJsonString(rawValue);
      if (method !== undefined) head.method = method;
    }

    index = skipJsonWhitespace(prefix, valueEnd);
    if (prefix[index] !== ",") return head;
    index = skipJsonWhitespace(prefix, index + 1);
  }
  return head;
}

function skipJsonWhitespace(text: string, start: number): number {
  let index = start;
  while (index < text.length && JSON_WHITESPACE.has(text[index] as string)) index += 1;
  return index;
}

function findJsonStringEnd(text: string, start: number): number | undefined {
  for (let index = start + 1; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\\") {
      index += 1;
    } else if (char === '"') {
      return index + 1;
    }
  }
  return undefined;
}

function findJsonValueEnd(text: string, start: number): number | undefined {
  let depth = 0;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"') {
      const stringEnd = findJsonStringEnd(text, index);
      if (stringEnd === undefined) return undefined;
      if (depth === 0) return stringEnd;
      index = stringEnd - 1;
    } else if (char === "{" || char === "[") {
      depth += 1;
    } else if (char === "}" || char === "]") {
      if (depth === 0) return index;
      depth -= 1;
      if (depth === 0) return index + 1;
    } else if (char === "," && depth === 0) {
      return index;
    }
  }
  return undefined;
}

function parseJsonString(raw: string): string | undefined {
  try {
    const value: unknown = JSON.parse(raw);
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

function parseJsonRpcId(raw: string): string | number | undefined {
  try {
    const value: unknown = JSON.parse(raw);
    return typeof value === "string" || (typeof value === "number" && Number.isFinite(value))
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}

function transportErrorMessage(input: CodexTransportErrorInput): string {
  switch (input.reason) {
    case "invalid-utf8":
      return `Codex app-server emitted invalid UTF-8 (${input.observedBytes} bytes).`;
    case "read-closed":
      return "Codex app-server stdout closed before process shutdown.";
    case "unterminated-frame":
      return `Codex app-server stdout ended with an unterminated JSONL frame (${input.observedBytes}/${input.maxBytes} bytes).`;
    case "frame-too-large":
      return `Codex app-server JSONL frame exceeded its byte limit (${input.observedBytes}/${input.maxBytes}).`;
    case "write-overloaded":
      return `Codex app-server stdin queue exceeded its byte limit (${input.observedBytes}/${input.maxBytes}).`;
    case "write-closed":
      return "Codex app-server stdin closed before the frame was written.";
  }
}
