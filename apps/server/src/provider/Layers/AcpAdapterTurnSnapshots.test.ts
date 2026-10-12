import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import * as OfficialAcp from "@agentclientprotocol/sdk";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId, type ChatImageAttachment } from "@synara/contracts";
import { Effect, FileSystem, Layer, Queue, Schedule, Sink, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { describe, expect, it } from "vitest";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import { CursorAdapter } from "../Services/CursorAdapter.ts";
import { GrokAdapter } from "../Services/GrokAdapter.ts";
import { makeCursorAdapterLive } from "./CursorAdapter.ts";
import { makeGrokAdapterLive } from "./GrokAdapter.ts";

function makeInMemoryAcpSpawner(onPrompt: (prompt: ReadonlyArray<unknown>) => void) {
  const closers: Array<() => void> = [];
  const agentApp = OfficialAcp.agent({ name: "turn-snapshot-agent" })
    .onRequest(OfficialAcp.methods.agent.initialize, () => ({
      protocolVersion: 1,
      agentCapabilities: { promptCapabilities: { image: true } },
      authMethods: [{ id: "cached_token", name: "Cached token" }],
    }))
    .onRequest(OfficialAcp.methods.agent.authenticate, () => ({}))
    .onRequest(OfficialAcp.methods.agent.session.new, () => ({
      sessionId: "turn-snapshot-session",
    }))
    .onRequest(OfficialAcp.methods.agent.session.prompt, ({ params }) => {
      onPrompt(params.prompt);
      return { stopReason: "end_turn" as const };
    });
  const spawner = ChildProcessSpawner.make(() =>
    Effect.sync(() => {
      const clientToAgent = Effect.runSync(Queue.unbounded<Uint8Array>());
      const agentToClient = Effect.runSync(Queue.unbounded<Uint8Array>());
      const connection = agentApp.connect(
        OfficialAcp.ndJsonStream(
          new WritableStream<Uint8Array>({
            write: (chunk) =>
              Effect.runPromise(Queue.offer(agentToClient, chunk)).then(() => undefined),
          }),
          new ReadableStream<Uint8Array>({
            pull: (controller) =>
              Effect.runPromise(Queue.take(clientToAgent)).then((chunk) => {
                controller.enqueue(chunk);
              }),
          }),
        ),
      );
      closers.push(() => {
        connection.close();
        Effect.runSync(Queue.shutdown(clientToAgent));
        Effect.runSync(Queue.shutdown(agentToClient));
      });
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(0x7ff_f_fffd),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
        isRunning: Effect.succeed(true),
        kill: () => Effect.void,
        stdin: Sink.forEach((chunk: Uint8Array) => Queue.offer(clientToAgent, chunk)),
        stdout: Stream.fromQueue(agentToClient),
        stderr: Stream.never,
        all: Stream.never,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.never,
      });
    }),
  );
  return { spawner, close: () => closers.forEach((close) => close()) };
}

const runImageTurnSnapshotCase =
  <I>(
    provider: "grok" | "cursor",
    adapterService: Effect.Effect<ProviderAdapterShape<ProviderAdapterError>, never, I>,
    makeAdapterLayer: () => Layer.Layer<
      I,
      never,
      ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | ServerConfig
    >,
  ) =>
  async () => {
    const homeDir = mkdtempSync(path.join(os.tmpdir(), `synara-${provider}-turns-home-`));
    const imageBytes = Buffer.from("turn-snapshot-image-bytes-".repeat(8));
    const imageBase64 = imageBytes.toString("base64");
    const attachment: ChatImageAttachment = {
      type: "image",
      id: "turn-snapshot-image",
      name: "pixel.png",
      mimeType: "image/png",
      sizeBytes: imageBytes.byteLength,
    };
    const dispatched: Array<ReadonlyArray<unknown>> = [];
    const fake = makeInMemoryAcpSpawner((prompt) => dispatched.push(prompt));
    const layer = makeAdapterLayer().pipe(
      Layer.provideMerge(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, fake.spawner)),
      Layer.provideMerge(
        ServerConfig.layerTest(
          process.cwd(),
          { prefix: `${provider}-turn-snapshot-` },
          { homeDir },
        ),
      ),
      Layer.provideMerge(NodeServices.layer),
    );
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const adapter = yield* adapterService;
          const serverConfig = yield* ServerConfig;
          const attachmentPath = resolveAttachmentPath({
            attachmentsDir: serverConfig.attachmentsDir,
            attachment,
          });
          if (!attachmentPath) throw new Error("attachment path did not resolve");
          mkdirSync(path.dirname(attachmentPath), { recursive: true });
          writeFileSync(attachmentPath, imageBytes);

          const threadId = ThreadId.makeUnsafe(`thread-${provider}-turn-snapshot`);
          yield* adapter.startSession({
            provider,
            threadId,
            runtimeMode: "full-access",
            cwd: process.cwd(),
          });
          const turn = yield* adapter.sendTurn({
            threadId,
            input: "describe the snapshot image",
            attachments: [attachment],
          });
          const snapshot = yield* adapter.readThread(threadId).pipe(
            Effect.filterOrFail(
              (current) => current.turns.length > 0,
              () => "turn-pending" as const,
            ),
            Effect.retry({
              schedule: Schedule.spaced("20 millis"),
              while: (error) => error === "turn-pending",
            }),
            Effect.timeout("10 seconds"),
          );
          expect(JSON.stringify(dispatched)).toContain(imageBase64);
          const serialized = JSON.stringify(snapshot);
          expect(serialized).not.toContain(imageBase64);
          expect(snapshot.turns.map((entry) => entry.id)).toEqual([turn.turnId]);
          expect(serialized).toContain("describe the snapshot image");
          expect(snapshot.turns[0]?.items[0]).toMatchObject({
            result: { stopReason: "end_turn" },
            prompt: expect.arrayContaining([
              expect.objectContaining({
                type: "image",
                attachmentId: attachment.id,
                mimeType: "image/png",
              }),
            ]),
          });
          yield* adapter.stopSession(threadId);
        }).pipe(Effect.scoped, Effect.provide(layer)),
      );
    } finally {
      fake.close();
    }
  };

describe("ACP adapter completed turn snapshots", () => {
  it(
    "Grok drops base64 image data from completed turns while readThread keeps the turn",
    runImageTurnSnapshotCase("grok", Effect.service(GrokAdapter), () => makeGrokAdapterLive()),
    20_000,
  );
  it(
    "Cursor drops base64 image data from completed turns while readThread keeps the turn",
    runImageTurnSnapshotCase("cursor", Effect.service(CursorAdapter), () =>
      makeCursorAdapterLive(),
    ),
    20_000,
  );
});
