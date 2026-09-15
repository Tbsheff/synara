import { EventEmitter } from "node:events";
import type { Writable } from "node:stream";

import { describe, expect, it } from "vitest";

import {
  CodexAppServerTransportError,
  CodexJsonlFramer,
  CodexJsonlWriter,
} from "./codexAppServerTransport.ts";

describe("Codex app-server transport", () => {
  it("frames split UTF-8 and rejects invalid or unterminated input", () => {
    const framer = new CodexJsonlFramer(64);
    const encoded = Buffer.from('{"text":"A😀B"}\r\n{"id":2}\n', "utf8");
    const emojiStart = encoded.indexOf(Buffer.from("😀", "utf8"));

    expect(framer.push(encoded.subarray(0, emojiStart + 2))).toEqual([]);
    expect(framer.push(encoded.subarray(emojiStart + 2))).toEqual(['{"text":"A😀B"}', '{"id":2}']);
    expect(framer.finish()).toBeUndefined();
    expect(framer.bufferedBytes).toBe(0);

    const unterminated = new CodexJsonlFramer(64);
    unterminated.push(Buffer.from('{"id":1}'));
    expect(() => unterminated.finish()).toThrowError(
      expect.objectContaining({ reason: "unterminated-frame" }),
    );

    expect(() => new CodexJsonlFramer(64).push(Buffer.from([0xff, 0x0a]))).toThrowError(
      expect.objectContaining({ reason: "invalid-utf8" }),
    );
  });

  it("discards an oversized frame split across chunks within the prefix budget", () => {
    const framer = new CodexJsonlFramer(64, 32);
    const encoded = Buffer.from(
      `{"id":7,"result":{"thread":{"id":"nested","turns":"${"x".repeat(400)}"}}}\n{"id":8}\n`,
    );
    const newline = encoded.indexOf(0x0a);
    const frames: unknown[] = [];

    for (let offset = 0; offset < encoded.length; offset += 5) {
      frames.push(...framer.push(encoded.subarray(offset, offset + 5)));
      const pushedBytes = Math.min(offset + 5, encoded.length);
      if (pushedBytes > 64 && pushedBytes <= newline) {
        expect(framer.bufferedBytes).toBeLessThanOrEqual(32);
      }
    }

    expect(frames).toEqual([
      { kind: "oversized", maxBytes: 64, observedBytes: newline, id: 7, payloadKey: "result" },
      '{"id":8}',
    ]);
    expect(framer.bufferedBytes).toBe(0);
    expect(framer.finish()).toBeUndefined();
  });

  it("reads top-level JSON-RPC id and method from an oversized frame prefix", () => {
    const framer = new CodexJsonlFramer(32, 256);
    const filler = "x".repeat(64);
    const frames = framer.push(
      [
        `{"method":"item/completed","params":{"id":"nested","output":"${filler}"}}`,
        `{"id":"srv-1","method":"item/tool/call","params":{"arguments":"${filler}"}}`,
        `{ "jsonrpc" : "2.0", "meta":{"id":9,"tags":["a\\"]"]}, "id" : 3 , "error":{"message":"${filler}"}}`,
        `not json at all ${filler}`,
        "",
      ].join("\n"),
    );

    expect(frames).toEqual([
      expect.objectContaining({
        kind: "oversized",
        method: "item/completed",
        payloadKey: "params",
      }),
      expect.objectContaining({ id: "srv-1", method: "item/tool/call", payloadKey: "params" }),
      expect.objectContaining({ id: 3, payloadKey: "error" }),
      expect.not.objectContaining({ id: expect.anything() }),
    ]);
    expect(frames[0]).not.toHaveProperty("id");
    expect(frames[2]).not.toHaveProperty("method");
    expect(frames[3]).toEqual({ kind: "oversized", maxBytes: 32, observedBytes: 80 });
  });

  it("ends an oversized frame when the newline or CRLF lands on a chunk boundary", () => {
    const framer = new CodexJsonlFramer(16, 64);
    const body = `{"id":1,"result":"${"x".repeat(40)}"}`;

    expect(framer.push(Buffer.from(body.slice(0, 20)))).toEqual([]);
    expect(framer.push(Buffer.from(`${body.slice(20)}\r`))).toEqual([]);
    expect(framer.push(Buffer.from("\n"))).toEqual([
      {
        kind: "oversized",
        maxBytes: 16,
        observedBytes: body.length + 1,
        id: 1,
        payloadKey: "result",
      },
    ]);
    expect(framer.push(Buffer.from(`${body}`))).toEqual([]);
    expect(framer.push(Buffer.from('\n{"id":2}\r\n'))).toEqual([
      expect.objectContaining({ kind: "oversized", id: 1, observedBytes: body.length }),
      '{"id":2}',
    ]);
  });

  it("finishes cleanly while an oversized frame is still being discarded", () => {
    const framer = new CodexJsonlFramer(16, 64);
    framer.push(Buffer.from(`{"id":4,"result":"${"x".repeat(40)}`));

    expect(framer.finish()).toEqual(
      expect.objectContaining({ kind: "oversized", id: 4, payloadKey: "result" }),
    );
    expect(framer.bufferedBytes).toBe(0);
    expect(() => framer.push(Buffer.from("{}\n"))).toThrowError(
      expect.objectContaining({ reason: "unterminated-frame" }),
    );
  });

  it("serializes slow stdin writes within one retained-byte budget", async () => {
    class ControlledWritable extends EventEmitter {
      writable = true;
      autoComplete = false;
      readonly chunks: Array<Buffer> = [];
      readonly callbacks: Array<(error?: Error | null) => void> = [];

      write(chunk: Uint8Array, callback: (error?: Error | null) => void): boolean {
        this.chunks.push(Buffer.from(chunk));
        if (this.autoComplete) {
          queueMicrotask(() => callback());
          return true;
        }
        this.callbacks.push(callback);
        return false;
      }

      release(): void {
        this.autoComplete = true;
        for (const callback of this.callbacks.splice(0)) callback();
        this.emit("drain");
      }
    }

    const stream = new ControlledWritable();
    const writer = new CodexJsonlWriter(stream as unknown as Writable, 64, 120);
    const messages = [1, 2, 3].map((id) => ({ id, payload: "x".repeat(16) }));
    const writes = messages.map((message) => writer.write(message));

    expect(stream.chunks).toHaveLength(1);
    expect(writer.bufferedBytes).toBeLessThanOrEqual(120);
    await expect(writer.write({ id: 4, payload: "x".repeat(16) })).rejects.toMatchObject({
      reason: "write-overloaded",
    });
    expect(writer.bufferedBytes).toBeLessThanOrEqual(120);

    stream.release();
    await Promise.all(writes);
    expect(writer.bufferedBytes).toBe(0);
    expect(stream.chunks.map((chunk) => JSON.parse(chunk.toString("utf8")))).toEqual(messages);

    const blockedStream = new ControlledWritable();
    const blockedWriter = new CodexJsonlWriter(blockedStream as unknown as Writable, 64, 120);
    const blockedWrite = blockedWriter.write({ id: "blocked" });
    blockedWriter.close(new Error("session stopped"));
    await expect(blockedWrite).rejects.toThrow("session stopped");
    expect(blockedWriter.bufferedBytes).toBe(0);
  });

  it("reports typed output frame errors", async () => {
    const stream = new EventEmitter() as EventEmitter & {
      writable: boolean;
      write: Writable["write"];
    };
    stream.writable = true;
    stream.write = (() => true) as Writable["write"];
    const writer = new CodexJsonlWriter(stream as unknown as Writable, 16, 32);

    await expect(writer.write({ payload: "x".repeat(32) })).rejects.toBeInstanceOf(
      CodexAppServerTransportError,
    );
  });
});
