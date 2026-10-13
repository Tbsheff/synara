import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import path from "node:path";
import { PassThrough } from "node:stream";
import {
  EventId,
  ApprovalRequestId,
  ProviderItemId,
  ProviderRuntimeEvent as ProviderRuntimeEventSchema,
  type ProviderApprovalDecision,
  type ProviderEvent,
  type ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderStartOptions,
  type ProviderTurnStartResult,
  type ProviderUserInputAnswers,
  ThreadId,
  TRANSCRIPT_OUTPUT_TAIL_MAX_CHARS,
  TurnId,
} from "@synara/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterAll, describe, it, vi } from "@effect/vitest";

import { Deferred, Effect, Fiber, FileSystem, Layer, Option, Schema, Stream } from "effect";

import {
  CodexAppServerManager,
  type CodexAppServerStartSessionInput,
  type CodexAppServerSendTurnInput,
  type CodexThreadStatusType,
} from "../../codexAppServerManager.ts";
import { CodexJsonlFramer, CodexJsonlWriter } from "../../codexAppServerTransport.ts";
import { ServerConfig } from "../../config.ts";
import { CodexSessionStartError } from "../../codexErrorClassification.ts";
import { resolveCodexGeneratedImagesRoots } from "../../codexGeneratedImages.ts";
import { ProviderAdapterValidationError } from "../Errors.ts";
import { CodexAdapter } from "../Services/CodexAdapter.ts";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory.ts";
import {
  CodexTranscriptTracker,
  makeCodexAdapterLive,
  makeCodexRuntimeEventMapper,
} from "./CodexAdapter.ts";

const asThreadId = (value: string): ThreadId => ThreadId.makeUnsafe(value);
const asTurnId = (value: string): TurnId => TurnId.makeUnsafe(value);
const asEventId = (value: string): EventId => EventId.makeUnsafe(value);
const asItemId = (value: string): ProviderItemId => ProviderItemId.makeUnsafe(value);

class FakeCodexManager extends CodexAppServerManager {
  public sessionSnapshots: ProviderSession[] = [];
  public codexOptionsByThreadId = new Map<
    ThreadId,
    NonNullable<ProviderStartOptions["codex"]> | undefined
  >();

  public startSessionImpl = vi.fn(
    async (input: CodexAppServerStartSessionInput): Promise<ProviderSession> => {
      const now = new Date().toISOString();
      return {
        provider: "codex",
        status: "ready",
        runtimeMode: input.runtimeMode,
        threadId: input.threadId,
        cwd: input.cwd,
        createdAt: now,
        updatedAt: now,
      };
    },
  );

  public sendTurnImpl = vi.fn(
    async (_input: CodexAppServerSendTurnInput): Promise<ProviderTurnStartResult> => ({
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-1"),
    }),
  );

  public steerTurnImpl = vi.fn(
    async (_input: CodexAppServerSendTurnInput): Promise<ProviderTurnStartResult> => ({
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-steer-1"),
    }),
  );

  public interruptTurnImpl = vi.fn(
    async (_threadId: ThreadId, _turnId?: TurnId, _providerThreadId?: string): Promise<void> =>
      undefined,
  );

  public readThreadImpl = vi.fn(async (_threadId: ThreadId) => ({
    threadId: asThreadId("thread-1"),
    turns: [],
  }));

  public rollbackThreadImpl = vi.fn(async (_threadId: ThreadId, _numTurns: number) => ({
    threadId: asThreadId("thread-1"),
    turns: [],
  }));

  public respondToRequestImpl = vi.fn(
    async (
      _threadId: ThreadId,
      _requestId: ApprovalRequestId,
      _decision: ProviderApprovalDecision,
    ): Promise<void> => undefined,
  );

  public respondToUserInputImpl = vi.fn(
    async (
      _threadId: ThreadId,
      _requestId: ApprovalRequestId,
      _answers: ProviderUserInputAnswers,
    ): Promise<void> => undefined,
  );

  public stopAllImpl = vi.fn(() => undefined);

  override startSession(input: CodexAppServerStartSessionInput): Promise<ProviderSession> {
    return this.startSessionImpl(input);
  }

  override sendTurn(input: CodexAppServerSendTurnInput): Promise<ProviderTurnStartResult> {
    return this.sendTurnImpl(input);
  }

  override steerTurn(input: CodexAppServerSendTurnInput): Promise<ProviderTurnStartResult> {
    return this.steerTurnImpl(input);
  }

  override interruptTurn(
    threadId: ThreadId,
    turnId?: TurnId,
    providerThreadId?: string,
  ): Promise<void> {
    return this.interruptTurnImpl(threadId, turnId, providerThreadId);
  }

  override readThread(threadId: ThreadId) {
    return this.readThreadImpl(threadId);
  }

  public readThreadStatusImpl = vi.fn(
    async (_threadId: ThreadId, _timeoutMs?: number): Promise<CodexThreadStatusType> => "idle",
  );

  override readThreadStatus(threadId: ThreadId, timeoutMs?: number) {
    return this.readThreadStatusImpl(threadId, timeoutMs);
  }

  override rollbackThread(threadId: ThreadId, numTurns: number) {
    return this.rollbackThreadImpl(threadId, numTurns);
  }

  override respondToRequest(
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ): Promise<void> {
    return this.respondToRequestImpl(threadId, requestId, decision);
  }

  override respondToUserInput(
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    answers: ProviderUserInputAnswers,
  ): Promise<void> {
    return this.respondToUserInputImpl(threadId, requestId, answers);
  }

  override async stopSession(_threadId: ThreadId): Promise<void> {}

  override listSessions(): ProviderSession[] {
    return this.sessionSnapshots;
  }

  private readonly rejectedOrigins = new WeakSet<object>();

  override getSessionEventOrigin(threadId: ThreadId) {
    const origin = this.sessionSnapshots.find((entry) => entry.threadId === threadId);
    return {
      providerInstanceId: this.sessionSnapshots.find((entry) => entry.threadId === threadId)
        ?.providerInstanceId,
      validationKey: origin,
      rejectInspection: () => {
        if (origin) this.rejectedOrigins.add(origin);
      },
      inspect: () => this.inspectSessionAsync(threadId),
      isAuthRejected: () => origin !== undefined && this.rejectedOrigins.has(origin),
      codexOptions: this.codexOptionsByThreadId.get(threadId),
    };
  }

  override async inspectSessionAsync(threadId: ThreadId) {
    const session = this.sessionSnapshots.find((entry) => entry.threadId === threadId);
    const codexOptions = this.codexOptionsByThreadId.get(threadId);
    return session ? { session, ...(codexOptions ? { codexOptions } : {}) } : undefined;
  }

  override inspectSessions(): ReturnType<CodexAppServerManager["inspectSessions"]> {
    return this.sessionSnapshots.map((session) => {
      const codexOptions = this.codexOptionsByThreadId.get(session.threadId);
      return {
        session,
        ...(codexOptions ? { codexOptions } : {}),
      };
    });
  }

  override getSessionCodexOptions(
    threadId: ThreadId,
  ): NonNullable<ProviderStartOptions["codex"]> | undefined {
    return this.codexOptionsByThreadId.get(threadId);
  }

  override hasSession(_threadId: ThreadId): boolean {
    return false;
  }

  override async stopAll(): Promise<void> {
    this.stopAllImpl();
  }
}

const providerSessionDirectoryTestLayer = Layer.succeed(ProviderSessionDirectory, {
  upsert: () => Effect.void,
  getProvider: () =>
    Effect.die(new Error("ProviderSessionDirectory.getProvider is not used in test")),
  getBinding: () => Effect.succeed(Option.none()),
  remove: () => Effect.void,
  listThreadIds: () => Effect.succeed([]),
  listBindings: () => Effect.succeed([]),
});

const validationManager = new FakeCodexManager();
const validationLayer = it.layer(
  makeCodexAdapterLive({ manager: validationManager }).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(providerSessionDirectoryTestLayer),
    Layer.provideMerge(NodeServices.layer),
  ),
);

validationLayer("CodexAdapterLive validation", (it) => {
  it.effect("passes the Hub coordinator tool grant to the Codex manager", () =>
    Effect.gen(function* () {
      validationManager.startSessionImpl.mockClear();
      const adapter = yield* CodexAdapter;
      yield* adapter.startSession({
        provider: "codex",
        threadId: asThreadId("thread-coordinator"),
        runtimeMode: "approval-required",
        autoApproveSynaraTools: true,
      });
      assert.strictEqual(
        validationManager.startSessionImpl.mock.calls[0]?.[0].autoApproveSynaraTools,
        true,
      );
    }),
  );

  it.effect(
    "preserves startup cleanup evidence without reclassifying unknown process failures",
    () =>
      Effect.gen(function* () {
        const adapter = yield* CodexAdapter;
        for (const cause of [
          new CodexSessionStartError("Codex stdout closed during initialization."),
          new Error("Failed to prove Codex app-server process-tree exit."),
        ]) {
          validationManager.startSessionImpl.mockRejectedValueOnce(cause);
          const result = yield* adapter
            .startSession({
              provider: "codex",
              threadId: asThreadId("thread-start-failed"),
              runtimeMode: "full-access",
            })
            .pipe(Effect.result);

          assert.equal(result._tag, "Failure");
          if (result._tag !== "Failure") throw new Error("Expected startup failure");
          assert.equal(result.failure._tag, "ProviderAdapterProcessError");
          if (result.failure._tag !== "ProviderAdapterProcessError") {
            throw new Error("Expected process failure");
          }
          assert.equal(
            result.failure.reason,
            cause instanceof CodexSessionStartError ? "startup-failed" : undefined,
          );
          assert.equal(result.failure.cause, cause);
          assert.equal(result.failure.detail, cause.message);
        }
      }),
  );

  it.effect("returns validation error for non-codex provider on startSession", () =>
    Effect.gen(function* () {
      validationManager.startSessionImpl.mockClear();
      const adapter = yield* CodexAdapter;
      const result = yield* adapter
        .startSession({
          provider: "claudeAgent",
          threadId: asThreadId("thread-1"),
          runtimeMode: "full-access",
        })
        .pipe(Effect.result);

      assert.equal(result._tag, "Failure");
      assert.deepStrictEqual(
        result.failure,
        new ProviderAdapterValidationError({
          provider: "codex",
          operation: "startSession",
          issue: "Expected provider 'codex' but received 'claudeAgent'.",
        }),
      );
      assert.equal(validationManager.startSessionImpl.mock.calls.length, 0);
    }),
  );

  it.effect("maps Codex thread status to provider thread activity", () =>
    Effect.gen(function* () {
      validationManager.readThreadStatusImpl.mockClear();
      const adapter = yield* CodexAdapter;
      const readThreadActivity = adapter.readThreadActivity;
      assert.ok(readThreadActivity);
      for (const [status, activity] of [
        ["active", "active"],
        ["idle", "idle"],
        ["notLoaded", "not-loaded"],
        ["systemError", "error"],
      ] as const) {
        validationManager.readThreadStatusImpl.mockResolvedValueOnce(status);
        assert.equal(yield* readThreadActivity(asThreadId("thread-1")), activity);
      }
      assert.deepStrictEqual(validationManager.readThreadStatusImpl.mock.calls[0], [
        asThreadId("thread-1"),
        5_000,
      ]);

      validationManager.readThreadStatusImpl.mockRejectedValueOnce(
        new Error("Timed out waiting for thread/read."),
      );
      const result = yield* readThreadActivity(asThreadId("thread-1")).pipe(Effect.result);
      assert.equal(result._tag, "Failure");
      if (result._tag !== "Failure") throw new Error("Expected probe failure");
      assert.equal(result.failure._tag, "ProviderAdapterRequestError");
    }),
  );

  it.effect("maps codex model options before starting a session", () =>
    Effect.gen(function* () {
      validationManager.startSessionImpl.mockClear();
      const adapter = yield* CodexAdapter;

      yield* adapter.startSession({
        provider: "codex",
        threadId: asThreadId("thread-1"),
        expectedCodexContinuationGeneration: "123e4567-e89b-42d3-a456-426614174000",
        lifecycleGeneration: "generation-start-a",
        modelSelection: {
          provider: "codex",
          model: "gpt-5.3-codex",
          options: {
            reasoningEffort: "high",
            fastMode: true,
          },
        },
        runtimeMode: "full-access",
      });

      assert.deepStrictEqual(validationManager.startSessionImpl.mock.calls[0]?.[0], {
        provider: "codex",
        threadId: asThreadId("thread-1"),
        lifecycleGeneration: "generation-start-a",
        model: "gpt-5.3-codex",
        effort: "high",
        serviceTier: "fast",
        expectedCodexContinuationGeneration: "123e4567-e89b-42d3-a456-426614174000",
        runtimeMode: "full-access",
        // The manager owns Codex session restarts, so it carries the capability
        // facts its gateway lease derives from.
        agentGatewayCapabilityInput: { enableComputerControl: false },
      });
    }),
  );
  it.effect("carries computer control into the manager's gateway lease facts", () =>
    Effect.gen(function* () {
      validationManager.startSessionImpl.mockClear();
      const adapter = yield* CodexAdapter;

      yield* adapter.startSession({
        provider: "codex",
        threadId: asThreadId("thread-computer"),
        enableComputerControl: true,
        runtimeMode: "full-access",
      });

      assert.deepStrictEqual(
        validationManager.startSessionImpl.mock.calls[0]?.[0]?.agentGatewayCapabilityInput,
        { enableComputerControl: true },
      );
    }),
  );
  it.effect("forwards an external fork cursor when starting a session", () =>
    Effect.gen(function* () {
      validationManager.startSessionImpl.mockClear();
      const adapter = yield* CodexAdapter;
      const forkSourceResumeCursor = { threadId: "external-codex-thread" };

      yield* adapter.startSession({
        provider: "codex",
        threadId: asThreadId("thread-import"),
        forkSourceResumeCursor,
        runtimeMode: "full-access",
      });

      assert.deepStrictEqual(validationManager.startSessionImpl.mock.calls[0]?.[0], {
        provider: "codex",
        threadId: asThreadId("thread-import"),
        forkSourceResumeCursor,
        runtimeMode: "full-access",
        agentGatewayCapabilityInput: { enableComputerControl: false },
      });
    }),
  );
  it.effect("explicitly selects Standard when opening a session with Fast disabled", () =>
    Effect.gen(function* () {
      validationManager.startSessionImpl.mockClear();
      const adapter = yield* CodexAdapter;

      yield* adapter.startSession({
        provider: "codex",
        threadId: asThreadId("thread-standard"),
        resumeCursor: { threadId: "previously-fast-thread" },
        modelSelection: {
          provider: "codex",
          model: "gpt-5.4",
          options: { fastMode: false },
        },
        runtimeMode: "full-access",
      });

      assert.equal(validationManager.startSessionImpl.mock.calls[0]?.[0].serviceTier, "default");
    }),
  );

  it.effect("lists only explicit generated-image homes from live session Codex options", () =>
    Effect.gen(function* () {
      const now = new Date().toISOString();
      const originalSynaraHome = process.env.SYNARA_HOME;
      process.env.SYNARA_HOME = "/tmp/synara-live-generated-images";
      validationManager.sessionSnapshots = [
        {
          provider: "codex",
          providerInstanceId: "codex_work" as ProviderInstanceId,
          status: "ready",
          runtimeMode: "full-access",
          threadId: asThreadId("thread-live-work"),
          createdAt: now,
          updatedAt: now,
        },
        {
          provider: "codex",
          providerInstanceId: "codex_disabled" as ProviderInstanceId,
          status: "ready",
          runtimeMode: "full-access",
          threadId: asThreadId("thread-live-disabled"),
          createdAt: now,
          updatedAt: now,
        },
        {
          provider: "codex",
          status: "ready",
          runtimeMode: "full-access",
          threadId: asThreadId("thread-live-without-context"),
          createdAt: now,
          updatedAt: now,
        },
      ];
      validationManager.codexOptionsByThreadId.clear();
      validationManager.codexOptionsByThreadId.set(asThreadId("thread-live-work"), {
        homePath: "/tmp/codex-live-work",
        accountId: "work",
      });
      validationManager.codexOptionsByThreadId.set(asThreadId("thread-live-disabled"), {
        homePath: "/tmp/codex-live-disabled",
        accountId: "disabled",
      });
      const adapter = yield* CodexAdapter;
      const listGeneratedImageHomePaths = adapter.listGeneratedImageHomePaths;
      if (!listGeneratedImageHomePaths) {
        throw new Error("Expected Codex adapter to expose generated-image home paths.");
      }
      const lifecycleListSpy = vi.spyOn(validationManager, "listSessions");
      const lifecycleOptionsSpy = vi.spyOn(validationManager, "getSessionCodexOptions");

      try {
        const homes = yield* listGeneratedImageHomePaths({
          enabledProviderInstanceIds: new Set(["codex_work" as ProviderInstanceId]),
        });

        assert.deepStrictEqual(homes, [
          {
            homePath: "/tmp/codex-live-work",
            accountId: "work",
          },
        ]);
        const roots = homes.flatMap((home) => resolveCodexGeneratedImagesRoots(home));
        assert.ok(roots.includes(path.join("/tmp/codex-live-work", "generated_images")));
        assert.ok(roots.some((root) => root.includes(path.join("codex-home-overlay", "accounts"))));
        assert.equal(
          lifecycleListSpy.mock.calls.length,
          0,
          "generated-image home inspection must not invoke lifecycle session pruning",
        );
        assert.equal(
          lifecycleOptionsSpy.mock.calls.length,
          0,
          "generated-image home inspection must not trigger per-session auth validation",
        );
      } finally {
        lifecycleOptionsSpy.mockRestore();
        lifecycleListSpy.mockRestore();
        if (originalSynaraHome === undefined) {
          delete process.env.SYNARA_HOME;
        } else {
          process.env.SYNARA_HOME = originalSynaraHome;
        }
        validationManager.sessionSnapshots = [];
        validationManager.codexOptionsByThreadId.clear();
      }
    }),
  );
});

const sessionErrorManager = new FakeCodexManager();
sessionErrorManager.sendTurnImpl.mockImplementation(async () => {
  throw new Error("Unknown session: sess-missing");
});
const sessionErrorLayer = it.layer(
  makeCodexAdapterLive({ manager: sessionErrorManager }).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(providerSessionDirectoryTestLayer),
    Layer.provideMerge(NodeServices.layer),
  ),
);

sessionErrorLayer("CodexAdapterLive session errors", (it) => {
  it.effect("maps unknown-session sendTurn errors to ProviderAdapterSessionNotFoundError", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const result = yield* adapter
        .sendTurn({
          threadId: asThreadId("sess-missing"),
          input: "hello",
          attachments: [],
        })
        .pipe(Effect.result);

      assert.equal(result._tag, "Failure");
      if (result._tag !== "Failure") {
        return;
      }

      assert.equal(result.failure._tag, "ProviderAdapterSessionNotFoundError");
      if (result.failure._tag !== "ProviderAdapterSessionNotFoundError") {
        return;
      }
      assert.equal(result.failure.provider, "codex");
      assert.equal(result.failure.threadId, "sess-missing");
      assert.equal(result.failure.cause instanceof Error, true);
    }),
  );

  it.effect("maps codex model options before sending a turn", () =>
    Effect.gen(function* () {
      sessionErrorManager.sendTurnImpl.mockClear();
      const adapter = yield* CodexAdapter;

      yield* Effect.ignore(
        adapter.sendTurn({
          threadId: asThreadId("sess-missing"),
          input: "hello",
          modelSelection: {
            provider: "codex",
            model: "gpt-5.3-codex",
            options: {
              reasoningEffort: "high",
              fastMode: true,
            },
          },
          attachments: [],
        }),
      );

      assert.deepStrictEqual(sessionErrorManager.sendTurnImpl.mock.calls[0]?.[0], {
        threadId: asThreadId("sess-missing"),
        input: "hello",
        model: "gpt-5.3-codex",
        effort: "high",
        serviceTier: "fast",
      });
    }),
  );
});

const turnPreparationManager = new FakeCodexManager();
const turnPreparationLayer = it.layer(
  makeCodexAdapterLive({ manager: turnPreparationManager }).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "codex-turn-input-" })),
    Layer.provideMerge(providerSessionDirectoryTestLayer),
    Layer.provideMerge(NodeServices.layer),
  ),
);

turnPreparationLayer("CodexAdapterLive turn input preparation", (it) => {
  it.effect("clears Fast mode on the next turn while preserving an unspecified tier", () =>
    Effect.gen(function* () {
      turnPreparationManager.sendTurnImpl.mockClear();
      const adapter = yield* CodexAdapter;

      for (const fastMode of [true, false, undefined]) {
        yield* adapter.sendTurn({
          threadId: asThreadId("thread-tier-toggle"),
          input: "Continue",
          attachments: [],
          modelSelection: {
            provider: "codex",
            model: "gpt-5.4",
            ...(fastMode !== undefined ? { options: { fastMode } } : {}),
          },
        });
      }

      const requests = turnPreparationManager.sendTurnImpl.mock.calls.map(([input]) => input);
      assert.deepStrictEqual(
        requests.map((input) => input.serviceTier),
        ["fast", "default", undefined],
      );
      assert.equal(Object.hasOwn(requests[2]!, "serviceTier"), false);
    }),
  );
  it.effect("prepares equivalent rich send and steer manager payloads", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const fileSystem = yield* FileSystem.FileSystem;
      const serverConfig = yield* ServerConfig;
      const imageBytes = Uint8Array.from([1, 2, 3, 4]);
      const imageId = "codex-rich-input-image";
      const fileId = "codex-rich-input-file";
      const imagePath = path.join(serverConfig.attachmentsDir, `${imageId}.png`);
      const filePath = path.join(serverConfig.attachmentsDir, `${fileId}.txt`);
      yield* fileSystem.writeFile(imagePath, imageBytes);
      yield* fileSystem.writeFileString(filePath, "notes");

      turnPreparationManager.sendTurnImpl.mockClear();
      turnPreparationManager.steerTurnImpl.mockClear();
      const input = {
        threadId: asThreadId("thread-rich-input"),
        input: "Inspect the attached context",
        attachments: [
          {
            type: "image" as const,
            id: imageId,
            name: "screen.png",
            mimeType: "image/png",
            sizeBytes: imageBytes.byteLength,
          },
          {
            type: "file" as const,
            id: fileId,
            name: "notes.txt",
            mimeType: "text/plain",
            sizeBytes: 5,
          },
        ],
        skills: [{ name: "check-code", path: "/skills/check-code/SKILL.md" }],
        mentions: [{ name: "github", path: "plugin://github@openai-curated" }],
        modelSelection: {
          provider: "codex" as const,
          model: "gpt-5.3-codex",
          options: {
            reasoningEffort: "high",
            fastMode: true,
          },
        },
        interactionMode: "plan" as const,
      };

      yield* adapter.sendTurn(input);
      const steerTurn = adapter.steerTurn;
      assert.ok(steerTurn);
      yield* steerTurn(input);

      const sendInput = turnPreparationManager.sendTurnImpl.mock.calls[0]?.[0];
      const steerInput = turnPreparationManager.steerTurnImpl.mock.calls[0]?.[0];
      assert.deepStrictEqual(steerInput, sendInput);
      assert.deepStrictEqual(sendInput, {
        threadId: asThreadId("thread-rich-input"),
        input: [
          "Inspect the attached context",
          "",
          "<attached_files>",
          "The user attached the following file(s), saved on disk. Read/extract them with your tools as needed; do not assume their contents.",
          `- \"notes.txt\" - text/plain - 5 B - ${filePath}`,
          "</attached_files>",
        ].join("\n"),
        skills: [{ name: "check-code", path: "/skills/check-code/SKILL.md" }],
        mentions: [{ name: "github", path: "plugin://github@openai-curated" }],
        model: "gpt-5.3-codex",
        effort: "high",
        serviceTier: "fast",
        interactionMode: "plan",
        attachments: [
          {
            type: "localImage",
            path: imagePath,
          },
        ],
      });
      assert.equal(turnPreparationManager.sendTurnImpl.mock.calls.length, 1);
      assert.equal(turnPreparationManager.steerTurnImpl.mock.calls.length, 1);
    }),
  );

  it.effect("preserves the steer method and cause for an invalid native image path", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      turnPreparationManager.steerTurnImpl.mockClear();
      const steerTurn = adapter.steerTurn;
      assert.ok(steerTurn);

      const result = yield* steerTurn({
        threadId: asThreadId("thread-invalid-image"),
        attachments: [
          {
            type: "image",
            id: "../invalid-image",
            name: "screen.png",
            mimeType: "image/png",
            sizeBytes: 4,
          },
        ],
      }).pipe(Effect.result);

      assert.equal(result._tag, "Failure");
      if (result._tag !== "Failure") {
        return;
      }
      assert.equal(result.failure._tag, "ProviderAdapterRequestError");
      if (result.failure._tag !== "ProviderAdapterRequestError") {
        return;
      }
      assert.equal(result.failure.method, "turn/steer");
      assert.equal(result.failure.detail, "Invalid attachment id '../invalid-image'.");
      assert.equal(result.failure.cause instanceof Error, true);
      assert.equal(turnPreparationManager.steerTurnImpl.mock.calls.length, 0);
    }),
  );
});

const lifecycleManager = new FakeCodexManager();
const lifecycleLayer = it.layer(
  makeCodexAdapterLive({ manager: lifecycleManager }).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(providerSessionDirectoryTestLayer),
    Layer.provideMerge(NodeServices.layer),
  ),
);

const realStopTeardown = vi.fn(async () => ({
  escalated: false,
  signalErrors: [],
  capturedBeforeRootExit: true,
}));
const realStopManager = new CodexAppServerManager(undefined, {
  teardownProcessTree: realStopTeardown,
});
const realStopLayer = it.layer(
  makeCodexAdapterLive({ manager: realStopManager }).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(providerSessionDirectoryTestLayer),
    Layer.provideMerge(NodeServices.layer),
  ),
);

realStopLayer("CodexAdapterLive real manager lifecycle", (it) => {
  it.effect("keeps a non-default provider instance on session/closed after map removal", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const threadId = asThreadId("thread-real-stop-work");
      const providerInstanceId = "codex_work" as ProviderInstanceId;
      class FakeCodexChild extends EventEmitter {
        readonly pid = 6060;
        exitCode: number | null = null;
        signalCode: NodeJS.Signals | null = null;
        killed = false;
        readonly stdin = new PassThrough();
        readonly stdout = new PassThrough();
        readonly stderr = new PassThrough();
      }
      const child = new FakeCodexChild();
      realStopTeardown.mockClear();
      (
        realStopManager as unknown as {
          sessions: Map<ThreadId, unknown>;
        }
      ).sessions.set(threadId, {
        session: {
          provider: "codex",
          providerInstanceId,
          status: "ready",
          runtimeMode: "full-access",
          threadId,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        account: { type: "unknown", planType: null, sparkEnabled: true },
        child,
        stdoutFramer: new CodexJsonlFramer(),
        stdinWriter: new CodexJsonlWriter(child.stdin),
        pending: new Map(),
        pendingApprovals: new Map(),
        pendingUserInputs: new Map(),
        collabReceiverTurns: new Map(),
        collabReceiverParents: new Map(),
        reviewTurnIds: new Set(),
        nextRequestId: 1,
        stopping: false,
      });
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      yield* adapter.stopSession(threadId);
      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "session.exited");
      assert.equal(firstEvent.value.providerInstanceId, providerInstanceId);
      assert.deepEqual(realStopManager.listSessions(), []);
      assert.equal(realStopTeardown.mock.calls.length, 1);
    }),
  );
});

lifecycleLayer("CodexAdapterLive lifecycle", (it) => {
  it.effect("stores lifecycle data once while retaining raw protocol metadata", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const marker = "unique-lifecycle-data-".repeat(500);
      for (const method of ["item/started", "item/completed"]) {
        const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);
        lifecycleManager.emit("event", {
          id: asEventId(`evt-single-data-${method}`),
          kind: "notification",
          provider: "codex",
          createdAt: new Date().toISOString(),
          method,
          threadId: asThreadId("thread-1"),
          turnId: asTurnId("turn-1"),
          itemId: asItemId("msg-single-data"),
          payload: {
            item: { type: "agentMessage", id: "msg-single-data", auditPayload: marker },
          },
        } satisfies ProviderEvent);
        const firstEvent = yield* Fiber.join(firstEventFiber);
        assert.equal(firstEvent._tag, "Some");
        if (firstEvent._tag !== "Some") return;
        const event = firstEvent.value;
        assert.equal(JSON.stringify(event).split(marker).length - 1, 1);
        assert.equal(event.raw?.method, method);
        assert.deepEqual(event.raw?.payload, {});
        assert.equal(event.threadId, "thread-1");
        assert.equal(event.itemId, "msg-single-data");
      }
    }),
  );

  it.effect("maps session/started to a canonical session.started runtime event", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      lifecycleManager.emit("event", {
        id: asEventId("evt-session-started"),
        kind: "session",
        provider: "codex",
        createdAt: new Date().toISOString(),
        method: "session/started",
        threadId: asThreadId("thread-1"),
        message: "Codex session ready for thread native-thread-1",
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);
      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "session.started");
      if (firstEvent.value.type !== "session.started") {
        return;
      }
      assert.equal(
        firstEvent.value.payload.message,
        "Codex session ready for thread native-thread-1",
      );
    }),
  );

  it.effect("normalizes whitespace in configuration warnings at the provider boundary", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      lifecycleManager.emit("event", {
        id: asEventId("evt-config-warning"),
        kind: "notification",
        provider: "codex",
        createdAt: new Date().toISOString(),
        method: "configWarning",
        threadId: asThreadId("thread-1"),
        payload: {
          summary: "  Invalid MCP configuration  ",
          details: "url is not supported for stdio\n",
          path: "  mcp_servers.synara  ",
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);
      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "config.warning");
      if (firstEvent.value.type !== "config.warning") {
        return;
      }
      assert.equal(firstEvent.value.payload.summary, "Invalid MCP configuration");
      assert.equal(firstEvent.value.payload.details, "url is not supported for stdio");
      assert.equal(firstEvent.value.payload.path, "mcp_servers.synara");
    }),
  );

  it.effect("maps Codex 0.144 reasoning summaries from canonical item arrays", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      lifecycleManager.emit("event", {
        id: asEventId("evt-reasoning-complete"),
        kind: "notification",
        provider: "codex",
        createdAt: new Date().toISOString(),
        method: "item/completed",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        itemId: asItemId("reasoning_1"),
        payload: {
          item: {
            type: "reasoning",
            id: "reasoning_1",
            summary: ["Inspect the protocol.", "Update the adapter."],
            content: [],
          },
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);
      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some" || firstEvent.value.type !== "item.completed") {
        return;
      }
      assert.equal(firstEvent.value.payload.itemType, "reasoning");
      assert.equal(firstEvent.value.payload.detail, "Inspect the protocol.\n\nUpdate the adapter.");
    }),
  );

  it.effect("maps structured reasoning summary parts without exposing raw content", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      lifecycleManager.emit("event", {
        id: asEventId("evt-structured-reasoning-complete"),
        kind: "notification",
        provider: "codex",
        createdAt: new Date().toISOString(),
        method: "item/completed",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        itemId: asItemId("reasoning_2"),
        payload: {
          item: {
            type: "reasoning",
            id: "reasoning_2",
            summary: [
              { type: "summary_text", text: "Inspect the protocol." },
              { summary: "Update the adapter." },
            ],
            content: [{ type: "reasoning_text", text: "private raw trace" }],
          },
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);
      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some" || firstEvent.value.type !== "item.completed") {
        return;
      }
      assert.equal(firstEvent.value.payload.detail, "Inspect the protocol.\n\nUpdate the adapter.");
    }),
  );

  it.effect("keeps Codex reasoning trace and summary delta streams distinct", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 2)).pipe(
        Effect.forkChild,
      );

      lifecycleManager.emit("event", {
        id: asEventId("evt-reasoning-trace-delta"),
        kind: "notification",
        provider: "codex",
        createdAt: new Date().toISOString(),
        method: "item/reasoning/textDelta",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        itemId: asItemId("reasoning_1"),
        payload: {
          threadId: "provider-thread-1",
          turnId: "turn-1",
          itemId: "reasoning_1",
          delta: "raw trace",
          contentIndex: 2,
        },
      } satisfies ProviderEvent);
      lifecycleManager.emit("event", {
        id: asEventId("evt-reasoning-summary-delta"),
        kind: "notification",
        provider: "codex",
        createdAt: new Date().toISOString(),
        method: "item/reasoning/summaryTextDelta",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        itemId: asItemId("reasoning_1"),
        payload: {
          threadId: "provider-thread-1",
          turnId: "turn-1",
          itemId: "reasoning_1",
          delta: "readable summary",
          summaryIndex: 1,
        },
      } satisfies ProviderEvent);

      const events = Array.from(yield* Fiber.join(eventsFiber));
      assert.equal(events[0]?.type, "content.delta");
      assert.equal(events[1]?.type, "content.delta");
      if (events[0]?.type === "content.delta") {
        assert.equal(events[0].payload.streamKind, "reasoning_text");
        assert.equal(events[0].payload.contentIndex, 2);
        assert.deepEqual(events[0].raw?.payload, {});
      }
      if (events[1]?.type === "content.delta") {
        assert.equal(events[1].payload.streamKind, "reasoning_summary_text");
        assert.equal(events[1].payload.summaryIndex, 1);
        assert.deepEqual(events[1].raw?.payload, {});
      }
    }),
  );

  it.effect("preserves failed commandExecution status from canonical completed items", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      lifecycleManager.emit("event", {
        id: asEventId("evt-command-failed"),
        kind: "notification",
        provider: "codex",
        createdAt: new Date().toISOString(),
        method: "item/completed",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        itemId: asItemId("command_1"),
        payload: {
          item: {
            type: "commandExecution",
            id: "command_1",
            command: "bun run test --runInBand",
            cwd: "/repo",
            status: "failed",
            commandActions: [],
            aggregatedOutput: "Unknown option --runInBand",
            exitCode: 1,
            durationMs: 42,
          },
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);
      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some" || firstEvent.value.type !== "item.completed") {
        return;
      }
      assert.equal(firstEvent.value.payload.itemType, "command_execution");
      assert.equal(firstEvent.value.payload.status, "failed");
      assert.equal(firstEvent.value.payload.title, "Ran command");
      assert.equal(firstEvent.value.payload.detail, "bun run test --runInBand");
    }),
  );

  it.effect("preserves Codex MCP and dynamic tool identity in lifecycle titles", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 2)).pipe(
        Effect.forkChild,
      );

      lifecycleManager.emit("event", {
        id: asEventId("evt-mcp-start"),
        kind: "notification",
        provider: "codex",
        createdAt: new Date().toISOString(),
        method: "item/started",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        itemId: asItemId("mcp_1"),
        payload: {
          item: {
            type: "mcpToolCall",
            id: "mcp_1",
            server: "computer-use",
            tool: "get_app_state",
            arguments: { app: "com.apple.Safari" },
            status: "inProgress",
            appContext: {
              connectorId: "computer-use",
              actionName: "Read the screen",
              appName: "Safari",
            },
          },
        },
      } satisfies ProviderEvent);
      lifecycleManager.emit("event", {
        id: asEventId("evt-dynamic-start"),
        kind: "notification",
        provider: "codex",
        createdAt: new Date().toISOString(),
        method: "item/started",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        itemId: asItemId("dynamic_1"),
        payload: {
          item: {
            type: "dynamicToolCall",
            id: "dynamic_1",
            tool: "read_workspace_file",
            arguments: {},
            status: "inProgress",
          },
        },
      } satisfies ProviderEvent);

      const events = Array.from(yield* Fiber.join(eventsFiber));
      assert.equal(events[0]?.type, "item.started");
      assert.equal(events[1]?.type, "item.started");
      if (events[0]?.type === "item.started") {
        assert.equal(events[0].payload.title, "Read the screen in Safari");
      }
      if (events[1]?.type === "item.started") {
        assert.equal(events[1].payload.title, "read_workspace_file");
      }
    }),
  );

  it.effect("maps current Codex MCP progress itemId and message fields", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      lifecycleManager.emit("event", {
        id: asEventId("evt-mcp-progress"),
        kind: "notification",
        provider: "codex",
        createdAt: new Date().toISOString(),
        method: "item/mcpToolCall/progress",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        itemId: asItemId("mcp_1"),
        payload: {
          threadId: "provider-thread-1",
          turnId: "turn-1",
          itemId: "mcp_1",
          message: "Waiting for Safari",
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);
      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some" || firstEvent.value.type !== "tool.progress") return;
      assert.equal(firstEvent.value.payload.toolUseId, "mcp_1");
      assert.equal(firstEvent.value.payload.summary, "Waiting for Safari");
    }),
  );

  it.effect("maps completed agent message items to canonical item.completed events", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      const event: ProviderEvent = {
        id: asEventId("evt-msg-complete"),
        kind: "notification",
        provider: "codex",
        createdAt: new Date().toISOString(),
        method: "item/completed",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        itemId: asItemId("msg_1"),
        payload: {
          item: {
            type: "agentMessage",
            id: "msg_1",
          },
        },
      };

      lifecycleManager.emit("event", event);
      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "item.completed");
      if (firstEvent.value.type !== "item.completed") {
        return;
      }
      assert.equal(firstEvent.value.itemId, "msg_1");
      assert.equal(firstEvent.value.turnId, "turn-1");
      assert.equal(firstEvent.value.payload.itemType, "assistant_message");
    }),
  );

  it.effect("preserves async questions without emitting a blocking request", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      const event: ProviderEvent = {
        id: asEventId("evt-msg-complete"),
        kind: "notification",
        provider: "codex",
        createdAt: new Date().toISOString(),
        method: "item/completed",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        itemId: asItemId("msg_1"),
        payload: {
          item: {
            type: "agentMessage",
            id: "msg_1",
            delivery: "async",
            questions: [
              { title: "Which action?", options: ["Click", "Scroll"] },
              { title: "Anything else?", options: null },
            ],
          },
        },
      };

      lifecycleManager.emit("event", event);
      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "item.completed");
      if (firstEvent.value.type !== "item.completed") {
        return;
      }
      assert.equal(firstEvent.value.itemId, "msg_1");
      assert.equal(firstEvent.value.turnId, "turn-1");
      assert.equal(firstEvent.value.payload.itemType, "assistant_message");
      assert.deepStrictEqual(firstEvent.value.payload.asyncQuestions, [
        { title: "Which action?", options: ["Click", "Scroll"] },
        { title: "Anything else?" },
      ]);
    }),
  );

  it.effect("falls back to assistant text for malformed async questions", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      const event: ProviderEvent = {
        id: asEventId("evt-msg-complete"),
        kind: "notification",
        provider: "codex",
        createdAt: new Date().toISOString(),
        method: "item/completed",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        itemId: asItemId("msg_1"),
        payload: {
          item: {
            type: "agentMessage",
            id: "msg_1",
            delivery: "async",
            text: "Which action?",
            questions: [{ title: "", options: ["Click"] }],
          },
        },
      };

      lifecycleManager.emit("event", event);
      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "item.completed");
      if (firstEvent.value.type !== "item.completed") {
        return;
      }
      assert.equal(firstEvent.value.itemId, "msg_1");
      assert.equal(firstEvent.value.turnId, "turn-1");
      assert.equal(firstEvent.value.payload.itemType, "assistant_message");
      assert.equal(firstEvent.value.payload.asyncQuestions, undefined);
      assert.equal(firstEvent.value.payload.detail, "Which action?");
    }),
  );

  it.effect("keeps inspected images out of generated output artifacts", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);
      const payload = {
        item: {
          type: "imageView",
          id: "view_1",
          path: "/attachments/objects/upload.png",
        },
      };
      lifecycleManager.emit("event", {
        id: asEventId("evt-image-view"),
        kind: "notification",
        provider: "codex",
        createdAt: new Date().toISOString(),
        method: "item/completed",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        itemId: asItemId("view_1"),
        payload,
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);
      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") return;
      assert.equal(firstEvent.value.type, "item.completed");
      if (firstEvent.value.type !== "item.completed") return;
      assert.equal(firstEvent.value.payload.itemType, "image_view");
      assert.equal(firstEvent.value.payload.title, "Image view");
      assert.deepStrictEqual(firstEvent.value.payload.data, payload);
    }),
  );

  it.effect("maps completed generated-image items to structured image artifacts", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      lifecycleManager.emit("event", {
        id: asEventId("evt-image-complete"),
        kind: "notification",
        provider: "codex",
        createdAt: new Date().toISOString(),
        method: "item/completed",
        threadId: asThreadId("thread-1"),
        providerThreadId: "provider-thread-1",
        turnId: asTurnId("turn-1"),
        itemId: asItemId("img_call_1"),
        payload: {
          item: {
            type: "image_generation_call",
            id: "img_call_1",
            saved_path: "/tmp/provider-thread-1/img_call_1.png",
            result: "large-inline-base64",
          },
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "item.completed");
      if (firstEvent.value.type !== "item.completed") {
        return;
      }
      assert.equal(firstEvent.value.payload.itemType, "image_generation");
      assert.equal(firstEvent.value.payload.title, "Generated image");
      assert.deepStrictEqual(firstEvent.value.payload.data, {
        kind: "codex.generated_image",
        path: "/tmp/provider-thread-1/img_call_1.png",
        callId: "img_call_1",
      });
      const rawPayload = firstEvent.value.raw?.payload as {
        item?: { result?: string; result_elided_for_relay?: boolean };
      };
      assert.equal(rawPayload.item?.result, undefined);
      assert.equal(rawPayload.item?.result_elided_for_relay, true);
    }),
  );

  it.effect("maps legacy image_generation_end notifications", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      lifecycleManager.emit("event", {
        id: asEventId("evt-image-end"),
        kind: "notification",
        provider: "codex",
        createdAt: new Date().toISOString(),
        method: "codex/event/image_generation_end",
        threadId: asThreadId("thread-1"),
        payload: {
          msg: {
            type: "image_generation_end",
            threadId: "provider-thread-1",
            turn_id: "turn-1",
            call_id: "img_call_2",
            saved_path: "/tmp/provider-thread-1/img_call_2.png",
          },
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "item.completed");
      if (firstEvent.value.type !== "item.completed") {
        return;
      }
      assert.equal(firstEvent.value.turnId, "turn-1");
      assert.equal(firstEvent.value.itemId, "img_call_2");
      assert.equal(firstEvent.value.payload.itemType, "image_generation");
      assert.deepStrictEqual(firstEvent.value.payload.data, {
        kind: "codex.generated_image",
        path: "/tmp/provider-thread-1/img_call_2.png",
        callId: "img_call_2",
      });
    }),
  );

  it.effect("maps exited review items to assistant completion events with review text", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      const event: ProviderEvent = {
        id: asEventId("evt-review-complete"),
        kind: "notification",
        provider: "codex",
        createdAt: new Date().toISOString(),
        method: "item/completed",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-review"),
        payload: {
          item: {
            type: "exitedReviewMode",
            id: "review_1",
            review: "Working tree is clean.",
          },
        },
      };

      lifecycleManager.emit("event", event);
      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "item.completed");
      if (firstEvent.value.type !== "item.completed") {
        return;
      }
      assert.equal(firstEvent.value.turnId, "turn-review");
      assert.equal(firstEvent.value.payload.itemType, "assistant_message");
      assert.equal(firstEvent.value.payload.detail, "Working tree is clean.");
    }),
  );

  it.effect("maps completed plan items to canonical proposed-plan completion events", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      const event: ProviderEvent = {
        id: asEventId("evt-plan-complete"),
        kind: "notification",
        provider: "codex",
        createdAt: new Date().toISOString(),
        method: "item/completed",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        itemId: asItemId("plan_1"),
        payload: {
          item: {
            type: "Plan",
            id: "plan_1",
            text: "## Final plan\n\n- one\n- two",
          },
        },
      };

      lifecycleManager.emit("event", event);
      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "turn.proposed.completed");
      if (firstEvent.value.type !== "turn.proposed.completed") {
        return;
      }
      assert.equal(firstEvent.value.turnId, "turn-1");
      assert.equal(firstEvent.value.payload.planMarkdown, "## Final plan\n\n- one\n- two");
    }),
  );

  it.effect("maps plan deltas to canonical proposed-plan delta events", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      lifecycleManager.emit("event", {
        id: asEventId("evt-plan-delta"),
        kind: "notification",
        provider: "codex",
        createdAt: new Date().toISOString(),
        method: "item/plan/delta",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        itemId: asItemId("plan_1"),
        payload: {
          delta: "## Final plan",
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "turn.proposed.delta");
      if (firstEvent.value.type !== "turn.proposed.delta") {
        return;
      }
      assert.equal(firstEvent.value.turnId, "turn-1");
      assert.equal(firstEvent.value.payload.delta, "## Final plan");
    }),
  );

  it.effect("maps session/closed lifecycle events to canonical session.exited runtime events", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      const event: ProviderEvent = {
        id: asEventId("evt-session-closed"),
        kind: "session",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        createdAt: new Date().toISOString(),
        method: "session/closed",
        message: "Session stopped",
      };

      lifecycleManager.emit("event", event);
      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "session.exited");
      if (firstEvent.value.type !== "session.exited") {
        return;
      }
      assert.equal(firstEvent.value.threadId, "thread-1");
      assert.equal(firstEvent.value.payload.reason, "Session stopped");
    }),
  );

  it.effect("stamps untagged Codex events without synchronous session filesystem reads", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      lifecycleManager.sessionSnapshots = [
        {
          provider: "codex",
          providerInstanceId: "codex_work",
          status: "ready",
          runtimeMode: "full-access",
          threadId: asThreadId("thread-1"),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ];
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);
      const blockingRead = () => {
        throw new Error("Synchronous session read on the stdout callback");
      };
      const listSpy = vi.spyOn(lifecycleManager, "listSessions").mockImplementation(blockingRead);
      const optionsSpy = vi
        .spyOn(lifecycleManager, "getSessionCodexOptions")
        .mockImplementation(blockingRead);
      try {
        lifecycleManager.emit("event", {
          id: asEventId("evt-session-closed-work"),
          kind: "session",
          provider: "codex",
          threadId: asThreadId("thread-1"),
          createdAt: new Date().toISOString(),
          method: "session/closed",
          message: "Work session stopped",
        } satisfies ProviderEvent);
      } finally {
        listSpy.mockRestore();
        optionsSpy.mockRestore();
      }
      const firstEvent = yield* Fiber.join(firstEventFiber);
      lifecycleManager.sessionSnapshots = [];

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "session.exited");
      assert.equal(firstEvent.value.providerInstanceId, "codex_work");
    }),
  );

  it.effect("fences unexpected inspection failures but preserves trusted manager closure", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const threadId = asThreadId("thread-inspection-error");
      lifecycleManager.sessionSnapshots = [
        {
          provider: "codex",
          providerInstanceId: "codex_work",
          threadId,
          status: "ready",
          runtimeMode: "full-access",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ];
      const inspection = vi
        .spyOn(lifecycleManager, "inspectSessionAsync")
        .mockRejectedValue(new Error("fixture unexpected error"));
      const collected = yield* Stream.runHead(
        adapter.streamEvents.pipe(Stream.filter((event) => event.threadId === threadId)),
      ).pipe(Effect.forkChild);
      try {
        for (const index of [0, 1])
          lifecycleManager.emit("event", {
            id: asEventId(`inspection-error-${index}`),
            provider: "codex",
            kind: "notification",
            threadId,
            method: "item/agentMessage/delta",
            createdAt: new Date().toISOString(),
            payload: { itemId: "inspection-error-assistant", delta: "rejected" },
          } satisfies ProviderEvent);
        lifecycleManager.emit("event", {
          id: asEventId("inspection-error-closed"),
          provider: "codex",
          kind: "session",
          threadId,
          method: "session/closed",
          createdAt: new Date().toISOString(),
          message: "Session stopped",
        } satisfies ProviderEvent);
        const result = yield* Fiber.join(collected);
        assert.equal(result._tag, "Some");
        if (result._tag === "Some") assert.equal(result.value.type, "session.exited");
        assert.equal(lifecycleManager.getSessionEventOrigin(threadId).isAuthRejected(), true);
      } finally {
        inspection.mockRestore();
        lifecycleManager.sessionSnapshots = [];
      }
    }),
  );

  it.effect(
    "publishes 3000 ordered deltas with slow coalesced auth checks without delta loss",
    () =>
      Effect.gen(function* () {
        const adapter = yield* CodexAdapter;
        const threadId = asThreadId("thread-throughput");
        lifecycleManager.sessionSnapshots = [
          {
            provider: "codex",
            providerInstanceId: "codex_work",
            threadId,
            status: "ready",
            runtimeMode: "full-access",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ];
        const original = lifecycleManager.inspectSessionAsync.bind(lifecycleManager);
        const releases: Array<() => void> = [];
        let active = 0;
        let maxActive = 0;
        const inspection = vi
          .spyOn(lifecycleManager, "inspectSessionAsync")
          .mockImplementation(async (id) => {
            if (id !== threadId) return original(id);
            active++;
            maxActive = Math.max(maxActive, active);
            await new Promise<void>((resolve) => releases.push(resolve));
            active--;
            return original(id);
          });
        const firstBatch = yield* Deferred.make<void>();
        const secondBatch = yield* Deferred.make<void>();
        const deltas: string[] = [];
        const collected = yield* Stream.runDrain(
          adapter.streamEvents.pipe(
            Stream.filter((event) => event.threadId === threadId && event.type === "content.delta"),
            Stream.take(3000),
            Stream.tap((event) =>
              Effect.gen(function* () {
                if (event.type === "content.delta") deltas.push(event.payload.delta);
                if (deltas.length === 500) yield* Deferred.succeed(firstBatch, undefined);
                if (deltas.length === 1900) yield* Deferred.succeed(secondBatch, undefined);
              }),
            ),
          ),
        ).pipe(Effect.forkChild);
        const emit = (from: number, count: number) => {
          for (let index = from; index < from + count; index++)
            lifecycleManager.emit("event", {
              id: asEventId(`throughput-${index}`),
              provider: "codex",
              kind: "notification",
              threadId,
              method: "item/agentMessage/delta",
              createdAt: new Date().toISOString(),
              payload: { itemId: "throughput-assistant", delta: `${index},` },
            } satisfies ProviderEvent);
        };
        try {
          emit(0, 500);
          yield* Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)));
          assert.equal(releases.length, 1);
          emit(500, 1400);
          assert.equal(releases.length, 1);
          releases[0]!();
          yield* Deferred.await(firstBatch);
          assert.equal(releases.length, 2);
          releases[1]!();
          yield* Deferred.await(secondBatch);
          emit(1900, 1100);
          yield* Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)));
          assert.equal(releases.length, 3);
          releases[2]!();
          yield* Fiber.join(collected);
          assert.deepEqual(
            deltas,
            Array.from({ length: 3000 }, (_, index) => `${index},`),
          );
          assert.equal(maxActive, 1);
        } finally {
          for (const release of releases) release();
          inspection.mockRestore();
          lifecycleManager.sessionSnapshots = [];
        }
      }),
  );

  it.effect(
    "retains origin identity and compact terminal events while auth inspection is pending",
    () =>
      Effect.gen(function* () {
        const adapter = yield* CodexAdapter;
        lifecycleManager.sessionSnapshots = [
          {
            provider: "codex",
            providerInstanceId: "codex_work",
            status: "ready",
            runtimeMode: "full-access",
            threadId: asThreadId("thread-1"),
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ];
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        const inspection = vi
          .spyOn(lifecycleManager, "inspectSessionAsync")
          .mockImplementation(async () => {
            await gate;
            return undefined;
          });
        const collected = yield* Stream.runCollect(adapter.streamEvents.pipe(Stream.take(3))).pipe(
          Effect.forkChild,
        );
        try {
          for (let i = 0; i < 3; i++)
            lifecycleManager.emit("event", {
              id: asEventId(`terminal-${i}`),
              kind: "notification",
              provider: "codex",
              threadId: asThreadId("thread-1"),
              lifecycleGeneration: "original-generation",
              createdAt: new Date().toISOString(),
              method: "turn/completed",
              turnId: asTurnId(`turn-${i}`),
              payload: {
                turn: { id: `turn-${i}`, status: "completed" },
                diagnostic: "x".repeat(12 * 1024 * 1024),
              },
            } satisfies ProviderEvent);
          lifecycleManager.sessionSnapshots = [];
          release();
          const events = yield* Fiber.join(collected);
          assert.equal(events.length, 3);
          for (const event of events) {
            assert.equal(event.type, "turn.completed");
            assert.equal(event.providerInstanceId, "codex_work");
            assert.equal(event.lifecycleGeneration, "original-generation");
            assert.ok(JSON.stringify(event).length < 512 * 1024);
          }
        } finally {
          release();
          inspection.mockRestore();
          lifecycleManager.sessionSnapshots = [];
        }
      }),
  );

  it.effect("maps retryable Codex error notifications to runtime.warning", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      lifecycleManager.emit("event", {
        id: asEventId("evt-retryable-error"),
        kind: "notification",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        createdAt: new Date().toISOString(),
        method: "error",
        turnId: asTurnId("turn-1"),
        payload: {
          error: {
            message: "Reconnecting... 2/5",
          },
          willRetry: true,
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "runtime.warning");
      if (firstEvent.value.type !== "runtime.warning") {
        return;
      }
      assert.equal(firstEvent.value.turnId, "turn-1");
      assert.equal(firstEvent.value.payload.message, "Reconnecting... 2/5");
      assert.equal(firstEvent.value.payload.willRetry, true);
    }),
  );

  it.effect("preserves overload identity on definitive Codex errors and failed completions", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      for (const method of ["error", "turn/completed"]) {
        const eventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);
        const error = { message: "Temporarily unavailable", codexErrorInfo: "serverOverloaded" };
        lifecycleManager.emit("event", {
          id: asEventId(`evt-overloaded-${method}`),
          kind: "notification",
          provider: "codex",
          threadId: asThreadId("thread-1"),
          turnId: asTurnId("turn-1"),
          createdAt: new Date().toISOString(),
          method,
          payload:
            method === "error"
              ? { error, willRetry: false }
              : { turn: { id: "turn-1", status: "failed", error } },
        } satisfies ProviderEvent);
        const event = yield* Fiber.join(eventFiber);
        assert.equal(event._tag, "Some");
        if (event._tag !== "Some") continue;
        assert.equal(event.value.type, method === "error" ? "runtime.error" : "turn.completed");
        if (event.value.type === "runtime.error" || event.value.type === "turn.completed") {
          assert.equal(event.value.payload.errorCode, "server_overloaded");
        }
      }
    }),
  );

  it.effect("maps non-fatal Codex error notifications to runtime.warning", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      lifecycleManager.emit("event", {
        id: asEventId("evt-non-fatal-error"),
        kind: "notification",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        createdAt: new Date().toISOString(),
        method: "error",
        turnId: asTurnId("turn-1"),
        payload: {
          error: {
            message:
              "write_stdin failed: stdin is closed for this session; rerun exec_command with tty=true to keep stdin open",
          },
          willRetry: false,
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "runtime.warning");
      if (firstEvent.value.type !== "runtime.warning") {
        return;
      }
      assert.equal(firstEvent.value.turnId, "turn-1");
      assert.equal(
        firstEvent.value.payload.message,
        "write_stdin failed: stdin is closed for this session; rerun exec_command with tty=true to keep stdin open",
      );
    }),
  );

  it.effect("maps process stderr provider errors to runtime.warning", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      lifecycleManager.emit("event", {
        id: asEventId("evt-process-stderr"),
        kind: "error",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        createdAt: new Date().toISOString(),
        method: "process/stderr",
        turnId: asTurnId("turn-1"),
        message: "write_stdin failed: stdin is closed for this session",
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "runtime.warning");
      if (firstEvent.value.type !== "runtime.warning") {
        return;
      }
      assert.equal(firstEvent.value.turnId, "turn-1");
      assert.equal(
        firstEvent.value.payload.message,
        "write_stdin failed: stdin is closed for this session",
      );
    }),
  );

  it.effect("preserves request type when mapping serverRequest/resolved", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      const event: ProviderEvent = {
        id: asEventId("evt-request-resolved"),
        kind: "notification",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        createdAt: new Date().toISOString(),
        method: "serverRequest/resolved",
        requestId: ApprovalRequestId.makeUnsafe("req-1"),
        payload: {
          request: {
            method: "item/commandExecution/requestApproval",
          },
          decision: "accept",
        },
      };

      lifecycleManager.emit("event", event);
      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "request.resolved");
      if (firstEvent.value.type !== "request.resolved") {
        return;
      }
      assert.equal(firstEvent.value.payload.requestType, "command_execution_approval");
    }),
  );

  it.effect("maps permission-profile approval requests to the canonical permission kind", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      lifecycleManager.emit("event", {
        id: asEventId("evt-permissions-request"),
        kind: "request",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        createdAt: new Date().toISOString(),
        method: "item/permissions/requestApproval",
        requestId: ApprovalRequestId.makeUnsafe("req-permissions-1"),
        requestKind: "permissions",
        payload: {
          reason: "Needs network access",
          permissions: { network: { enabled: true } },
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);
      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some" || firstEvent.value.type !== "request.opened") return;
      assert.equal(firstEvent.value.payload.requestType, "permissions_approval");
      assert.equal(firstEvent.value.payload.detail, "Needs network access");
      assert.deepEqual(firstEvent.value.payload.args, {
        reason: "Needs network access",
        permissions: { network: { enabled: true } },
      });
    }),
  );

  it.effect("maps MCP tool-call approval elicitations to tool approvals", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      lifecycleManager.emit("event", {
        id: asEventId("evt-mcp-tool-approval"),
        kind: "request",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        createdAt: new Date().toISOString(),
        method: "mcpServer/elicitation/request",
        requestId: ApprovalRequestId.makeUnsafe("req-mcp-tool-1"),
        requestKind: "tool",
        payload: {
          message: "Allow the tool call?",
          _meta: {
            tool_name: "computer_launch_app",
            tool_params_display: [{ name: "app", value: "kcalc" }],
          },
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);
      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some" || firstEvent.value.type !== "request.opened") return;
      assert.equal(firstEvent.value.payload.requestType, "tool_approval");
      assert.equal(firstEvent.value.payload.detail, "Allow the tool call?");
      assert.deepEqual(firstEvent.value.payload.args, {
        message: "Allow the tool call?",
        _meta: {
          tool_name: "computer_launch_app",
          tool_params_display: [{ name: "app", value: "kcalc" }],
        },
      });
    }),
  );

  it.effect("maps declined MCP elicitations to an mcp-elicitation transcript notice", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      lifecycleManager.emit("event", {
        id: asEventId("evt-mcp-elicitation-notice"),
        kind: "notification",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        createdAt: new Date().toISOString(),
        method: "mcpServer/elicitation/request/unrenderable",
        payload: { serverName: "linear", message: "Sign in to continue" },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);
      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") return;
      assert.equal(firstEvent.value.type, "transcript.notice");
      if (firstEvent.value.type !== "transcript.notice") return;
      assert.equal(firstEvent.value.payload.noticeKind, "mcp-elicitation");
      assert.equal(firstEvent.value.payload.title, "linear requested information (not supported)");
      assert.equal(firstEvent.value.payload.detail, "Sign in to continue");
      assert.equal(firstEvent.value.payload.status, "cancelled");
    }),
  );

  it.effect("preserves file-read request type when mapping serverRequest/resolved", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      const event: ProviderEvent = {
        id: asEventId("evt-file-read-request-resolved"),
        kind: "notification",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        createdAt: new Date().toISOString(),
        method: "serverRequest/resolved",
        requestId: ApprovalRequestId.makeUnsafe("req-file-read-1"),
        payload: {
          request: {
            method: "item/fileRead/requestApproval",
          },
          decision: "accept",
        },
      };

      lifecycleManager.emit("event", event);
      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "request.resolved");
      if (firstEvent.value.type !== "request.resolved") {
        return;
      }
      assert.equal(firstEvent.value.payload.requestType, "file_read_approval");
    }),
  );

  it.effect("preserves explicit empty multi-select user-input answers", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      const event: ProviderEvent = {
        id: asEventId("evt-user-input-empty"),
        kind: "notification",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        createdAt: new Date().toISOString(),
        method: "item/tool/requestUserInput/answered",
        payload: {
          answers: {
            scope: [],
          },
        },
      };

      lifecycleManager.emit("event", event);
      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "user-input.resolved");
      if (firstEvent.value.type !== "user-input.resolved") {
        return;
      }
      assert.deepEqual(firstEvent.value.payload.answers, {
        scope: [],
      });
    }),
  );

  it.effect("maps windowsSandbox/setupCompleted to session state and warning on failure", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 2)).pipe(
        Effect.forkChild,
      );

      const event: ProviderEvent = {
        id: asEventId("evt-windows-sandbox-failed"),
        kind: "notification",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        createdAt: new Date().toISOString(),
        method: "windowsSandbox/setupCompleted",
        message: "Sandbox setup failed",
        payload: {
          success: false,
          detail: "unsupported environment",
        },
      };

      lifecycleManager.emit("event", event);
      const events = Array.from(yield* Fiber.join(eventsFiber));

      assert.equal(events.length, 2);

      const firstEvent = events[0];
      const secondEvent = events[1];

      assert.notEqual(firstEvent?.eventId, secondEvent?.eventId);
      assert.equal(firstEvent?.type, "session.state.changed");
      if (firstEvent?.type === "session.state.changed") {
        assert.equal(firstEvent.payload.state, "error");
        assert.equal(firstEvent.payload.reason, "Sandbox setup failed");
      }

      assert.equal(secondEvent?.type, "runtime.warning");
      if (secondEvent?.type === "runtime.warning") {
        assert.equal(secondEvent.payload.message, "Sandbox setup failed");
      }
    }),
  );

  it.effect(
    "maps requestUserInput requests and answered notifications to canonical user-input events",
    () =>
      Effect.gen(function* () {
        const adapter = yield* CodexAdapter;
        const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 2)).pipe(
          Effect.forkChild,
        );

        lifecycleManager.emit("event", {
          id: asEventId("evt-user-input-requested"),
          kind: "request",
          provider: "codex",
          threadId: asThreadId("thread-1"),
          createdAt: new Date().toISOString(),
          lifecycleGeneration: "generation-request-a",
          method: "item/tool/requestUserInput",
          requestId: ApprovalRequestId.makeUnsafe("req-user-input-1"),
          payload: {
            questions: [
              {
                id: "sandbox_mode",
                header: "Sandbox",
                question: "Which mode should be used?",
                options: [
                  {
                    label: "workspace-write",
                    description: "Allow workspace writes only",
                  },
                ],
              },
            ],
          },
        } satisfies ProviderEvent);
        lifecycleManager.emit("event", {
          id: asEventId("evt-user-input-resolved"),
          kind: "notification",
          provider: "codex",
          threadId: asThreadId("thread-1"),
          createdAt: new Date().toISOString(),
          lifecycleGeneration: "generation-request-a",
          method: "item/tool/requestUserInput/answered",
          requestId: ApprovalRequestId.makeUnsafe("req-user-input-1"),
          payload: {
            answers: {
              sandbox_mode: {
                answers: ["workspace-write"],
              },
            },
          },
        } satisfies ProviderEvent);

        const events = Array.from(yield* Fiber.join(eventsFiber));
        assert.equal(events[0]?.type, "user-input.requested");
        if (events[0]?.type === "user-input.requested") {
          assert.equal(events[0].requestId, "req-user-input-1");
          assert.equal(events[0].lifecycleGeneration, "generation-request-a");
          assert.equal(events[0].payload.questions[0]?.id, "sandbox_mode");
        }

        assert.equal(events[1]?.type, "user-input.resolved");
        if (events[1]?.type === "user-input.resolved") {
          assert.equal(events[1].requestId, "req-user-input-1");
          assert.equal(events[1].lifecycleGeneration, "generation-request-a");
          assert.deepEqual(events[1].payload.answers, {
            sandbox_mode: "workspace-write",
          });
        }
      }),
  );

  it.effect("maps Codex task and reasoning event chunks into canonical runtime events", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 5)).pipe(
        Effect.forkChild,
      );

      lifecycleManager.emit("event", {
        id: asEventId("evt-codex-task-started"),
        kind: "notification",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        createdAt: new Date().toISOString(),
        method: "codex/event/task_started",
        payload: {
          id: "turn-structured-1",
          msg: {
            type: "task_started",
            turn_id: "turn-structured-1",
            collaboration_mode_kind: "plan",
          },
        },
      } satisfies ProviderEvent);

      lifecycleManager.emit("event", {
        id: asEventId("evt-codex-agent-reasoning"),
        kind: "notification",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        createdAt: new Date().toISOString(),
        method: "codex/event/agent_reasoning",
        payload: {
          id: "turn-structured-1",
          msg: {
            type: "agent_reasoning",
            text: "Need to compare both transport layers before finalizing the plan.",
          },
        },
      } satisfies ProviderEvent);

      lifecycleManager.emit("event", {
        id: asEventId("evt-codex-reasoning-delta"),
        kind: "notification",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        createdAt: new Date().toISOString(),
        method: "codex/event/reasoning_content_delta",
        payload: {
          id: "turn-structured-1",
          msg: {
            type: "reasoning_content_delta",
            turn_id: "turn-structured-1",
            item_id: "rs_reasoning_1",
            delta: "**Compare** transport boundaries",
            summary_index: 0,
          },
        },
      } satisfies ProviderEvent);

      lifecycleManager.emit("event", {
        id: asEventId("evt-codex-task-complete"),
        kind: "notification",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        createdAt: new Date().toISOString(),
        method: "codex/event/task_complete",
        payload: {
          id: "turn-structured-1",
          msg: {
            type: "task_complete",
            turn_id: "turn-structured-1",
            last_agent_message: "<proposed_plan>\n# Ship it\n</proposed_plan>",
          },
        },
      } satisfies ProviderEvent);

      const events = Array.from(yield* Fiber.join(eventsFiber));

      assert.equal(events[0]?.type, "task.started");
      if (events[0]?.type === "task.started") {
        assert.equal(events[0].turnId, "turn-structured-1");
        assert.equal(events[0].payload.taskId, "turn-structured-1");
        assert.equal(events[0].payload.taskType, "plan");
      }

      assert.equal(events[1]?.type, "task.progress");
      if (events[1]?.type === "task.progress") {
        assert.equal(events[1].payload.taskId, "turn-structured-1");
        assert.equal(
          events[1].payload.description,
          "Need to compare both transport layers before finalizing the plan.",
        );
      }

      assert.equal(events[2]?.type, "content.delta");
      if (events[2]?.type === "content.delta") {
        assert.equal(events[2].turnId, "turn-structured-1");
        assert.equal(events[2].itemId, "rs_reasoning_1");
        assert.equal(events[2].payload.streamKind, "reasoning_summary_text");
        assert.equal(events[2].payload.summaryIndex, 0);
        assert.deepEqual(events[2].raw?.payload, {});
      }

      assert.equal(events[3]?.type, "task.completed");
      if (events[3]?.type === "task.completed") {
        assert.equal(events[3].turnId, "turn-structured-1");
        assert.equal(events[3].payload.taskId, "turn-structured-1");
        assert.equal(events[3].payload.summary, "<proposed_plan>\n# Ship it\n</proposed_plan>");
      }

      assert.equal(events[4]?.type, "turn.proposed.completed");
      if (events[4]?.type === "turn.proposed.completed") {
        assert.equal(events[4].turnId, "turn-structured-1");
        assert.equal(events[4].payload.planMarkdown, "# Ship it");
      }
      assert.notEqual(events[3]?.eventId, events[4]?.eventId);
    }),
  );

  it.effect("prefers manager-assigned turn ids for Codex task events", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      lifecycleManager.emit("event", {
        id: asEventId("evt-codex-task-started-parent-turn"),
        kind: "notification",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-parent"),
        createdAt: new Date().toISOString(),
        method: "codex/event/task_started",
        payload: {
          id: "turn-child",
          msg: {
            type: "task_started",
            turn_id: "turn-child",
            collaboration_mode_kind: "default",
          },
          conversationId: "child-provider-thread",
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);
      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "task.started");
      if (firstEvent.value.type !== "task.started") {
        return;
      }
      assert.equal(firstEvent.value.turnId, "turn-parent");
      assert.equal(firstEvent.value.providerRefs?.providerTurnId, "turn-parent");
      assert.equal(firstEvent.value.payload.taskId, "turn-child");
    }),
  );

  it.effect("unwraps Codex token usage payloads for context window events", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      lifecycleManager.emit("event", {
        id: asEventId("evt-codex-thread-token-usage-updated"),
        kind: "notification",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        createdAt: new Date().toISOString(),
        method: "thread/tokenUsage/updated",
        payload: {
          threadId: "thread-1",
          turnId: "turn-1",
          tokenUsage: {
            total: {
              inputTokens: 11_833,
              cachedInputTokens: 3456,
              cacheWriteInputTokens: 500,
              outputTokens: 6,
              reasoningOutputTokens: 0,
              totalTokens: 11_839,
            },
            last: {
              inputTokens: 120,
              cachedInputTokens: 0,
              outputTokens: 6,
              reasoningOutputTokens: 0,
              totalTokens: 126,
            },
            modelContextWindow: 258_400,
          },
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);
      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "thread.token-usage.updated");
      if (firstEvent.value.type !== "thread.token-usage.updated") {
        return;
      }

      assert.deepEqual(firstEvent.value.payload.usage, {
        usedTokens: 126,
        cumulativeUsage: {
          inputTokens: 11_833,
          outputTokens: 6,
          cachedInputTokens: 3456,
          cacheCreationInputTokens: 500,
        },
        totalProcessedTokens: 11_839,
        maxTokens: 258_400,
        inputTokens: 120,
        cachedInputTokens: 0,
        outputTokens: 6,
        reasoningOutputTokens: 0,
        lastUsedTokens: 126,
        lastInputTokens: 120,
        lastCachedInputTokens: 0,
        lastOutputTokens: 6,
        lastReasoningOutputTokens: 0,
        compactsAutomatically: true,
      });
    }),
  );

  it.effect("maps thread/compacting notifications to context compaction progress events", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      lifecycleManager.emit("event", {
        id: asEventId("evt-codex-thread-compacting"),
        kind: "notification",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        createdAt: new Date().toISOString(),
        method: "thread/compacting",
        message: "Compacting context",
        payload: {
          threadId: "thread-1",
          state: "compacting",
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);
      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "item.updated");
      if (firstEvent.value.type !== "item.updated") {
        return;
      }
      assert.equal(firstEvent.value.payload.itemType, "context_compaction");
      assert.equal(firstEvent.value.payload.detail, "Compacting context");
      assert.equal(firstEvent.value.payload.status, "inProgress");
    }),
  );

  it.effect("maps Codex hook notifications to bounded canonical lifecycle events", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const eventsFiber = yield* Stream.take(adapter.streamEvents, 2).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );
      const commonRun = {
        id: "hook-run-1",
        eventName: "preToolUse",
        executionMode: "sync",
        handlerType: "command",
        scope: "turn",
        source: "user",
        sourcePath: "/Users/example/.codex/hooks.json",
        displayOrder: 0,
        startedAt: 100,
      };

      lifecycleManager.emit("event", {
        id: asEventId("evt-codex-hook-started"),
        kind: "notification",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        createdAt: new Date().toISOString(),
        method: "hook/started",
        payload: {
          threadId: "thread-1",
          turnId: "turn-1",
          run: {
            ...commonRun,
            status: "running",
            statusMessage: null,
            completedAt: null,
            durationMs: null,
            entries: [],
          },
        },
      } satisfies ProviderEvent);
      lifecycleManager.emit("event", {
        id: asEventId("evt-codex-hook-completed"),
        kind: "notification",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        createdAt: new Date().toISOString(),
        method: "hook/completed",
        payload: {
          threadId: "thread-1",
          turnId: "turn-1",
          run: {
            ...commonRun,
            status: "blocked",
            statusMessage: "api_key=private-hook-secret blocked this action",
            completedAt: 112,
            durationMs: 12,
            entries: [{ kind: "error", text: "Authorization: Bearer private-hook-token" }],
          },
        },
      } satisfies ProviderEvent);

      const events = Array.from(yield* Fiber.join(eventsFiber));
      assert.equal(events.length, 2);
      const [started, completed] = events;
      assert.equal(started?.type, "hook.started");
      if (started?.type !== "hook.started") return;
      assert.deepEqual(started.payload, {
        hookId: "hook-run-1",
        hookName: "/Users/example/.codex/hooks.json",
        hookEvent: "preToolUse",
        data: {
          ...commonRun,
          status: "running",
          statusMessage: null,
          completedAt: null,
          durationMs: null,
          entries: [],
        },
      });
      assert.deepEqual(started.raw?.payload, { synaraSanitized: true });

      assert.equal(completed?.type, "hook.completed");
      if (completed?.type !== "hook.completed") return;
      assert.equal(completed.payload.outcome, "cancelled");
      assert.equal(completed.payload.status, "blocked");
      assert.equal(completed.payload.durationMs, 12);
      const serialized = JSON.stringify(completed);
      assert.equal(serialized.includes("private-hook-secret"), false);
      assert.equal(serialized.includes("private-hook-token"), false);
      assert.equal(serialized.includes("[REDACTED]"), true);
      assert.deepEqual(completed.raw?.payload, { synaraSanitized: true });
    }),
  );

  it.effect(
    "surfaces previously-unmapped native events with bounded redacted diagnostics instead of raw payloads",
    () =>
      Effect.gen(function* () {
        const adapter = yield* CodexAdapter;
        const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

        // `item/agentMessage/completed` has no explicit mapping (only the
        // `item/agentMessage/delta` stream does); before the passthrough
        // fallback this event produced no runtime event at all.
        lifecycleManager.emit("event", {
          id: asEventId("evt-unmapped-agent-message-completed"),
          kind: "notification",
          provider: "codex",
          createdAt: new Date().toISOString(),
          method: "item/agentMessage/completed",
          threadId: asThreadId("thread-1"),
          turnId: asTurnId("turn-1"),
          itemId: asItemId("agent_message_9"),
          payload: {
            apiKey: "must-not-reach-the-runtime-journal",
            note: "Authorization: Bearer private-token",
            msg: {
              type: "item/agentMessage/completed",
              item_id: "agent_message_9",
              summary: "Finished the refactor",
            },
            output: "x".repeat(64_000),
          },
        } satisfies ProviderEvent);

        const firstEvent = yield* Fiber.join(firstEventFiber);
        assert.equal(firstEvent._tag, "Some");
        if (firstEvent._tag !== "Some") {
          return;
        }
        assert.equal(firstEvent.value.type, "event.unmapped");
        if (firstEvent.value.type !== "event.unmapped") {
          return;
        }
        // Raw native type/label is carried as the title source.
        assert.equal(firstEvent.value.payload.nativeType, "item/agentMessage/completed");
        assert.equal(firstEvent.value.payload.detail, "Finished the refactor");
        const serialized = JSON.stringify(firstEvent.value);
        assert.equal(serialized.includes("must-not-reach-the-runtime-journal"), false);
        assert.equal(serialized.includes("private-token"), false);
        assert.ok(serialized.length < 17_000);
        assert.deepEqual(firstEvent.value.raw?.payload, {
          synaraSanitized: true,
        });
        // Provider refs still resolved from the raw event.
        assert.equal(firstEvent.value.itemId, "agent_message_9");
        assert.equal(firstEvent.value.providerRefs?.providerItemId, "agent_message_9");
      }),
  );

  it.effect("keeps routine Codex startup notifications out of the activity stream", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const eventsFiber = yield* Stream.take(adapter.streamEvents, 3).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );
      const emit = (method: string, kind: ProviderEvent["kind"] = "notification") =>
        lifecycleManager.emit("event", {
          id: asEventId(`startup-${method}-${kind}`),
          kind,
          provider: "codex",
          createdAt: new Date().toISOString(),
          method,
          threadId: asThreadId("startup-thread"),
          ...(kind === "error" ? { message: "Failed to open thread" } : {}),
          payload: { status: "disabled" },
        } satisfies ProviderEvent);

      emit("remoteControl/status/changed");
      emit("session/threadOpenRequested", "session");
      emit("session/threadOpenRequested", "error");
      emit("item/future/completed");
      emit("session/started", "session");

      const events = Array.from(yield* Fiber.join(eventsFiber));
      assert.deepEqual(
        events.map((event) => event.type),
        ["runtime.error", "event.unmapped", "session.started"],
      );
      assert.equal(
        events[1]?.type === "event.unmapped" ? events[1].payload.nativeType : undefined,
        "item/future/completed",
      );
    }),
  );

  it.effect("coalesces repeated unmapped burst events", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const eventsFiber = yield* Stream.take(adapter.streamEvents, 2).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );
      const emit = (id: string, method: string) =>
        lifecycleManager.emit("event", {
          id: asEventId(id),
          kind: "notification",
          provider: "codex",
          createdAt: new Date().toISOString(),
          method,
          threadId: asThreadId("thread-unmapped-burst"),
          turnId: asTurnId("turn-unmapped-burst"),
          payload: { summary: method },
        } satisfies ProviderEvent);

      emit("evt-unmapped-delta-1", "item/future/outputDelta");
      emit("evt-unmapped-delta-2", "item/future/outputDelta");
      emit("evt-unmapped-completed", "item/future/completed");

      const events = Array.from(yield* Fiber.join(eventsFiber));
      assert.deepEqual(
        events.map((event) =>
          event.type === "event.unmapped" ? event.payload.nativeType : event.type,
        ),
        ["item/future/outputDelta", "item/future/completed"],
      );
    }),
  );
});

afterAll(() => {
  if (lifecycleManager.stopAllImpl.mock.calls.length === 0) {
    lifecycleManager.stopAll();
  }
  assert.ok(lifecycleManager.stopAllImpl.mock.calls.length >= 1);
});

describe("Codex runtime event mapper transcript details", () => {
  const mapperThreadId = asThreadId("thread-mapper");
  const mapperTurnId = asTurnId("turn-mapper");
  let sequence = 0;
  const native = (
    method: string,
    payload: Record<string, unknown>,
    overrides: Partial<ProviderEvent> = {},
  ): ProviderEvent => ({
    id: asEventId(`evt-mapper-${(sequence += 1)}`),
    kind: "notification",
    provider: "codex",
    threadId: mapperThreadId,
    createdAt: "2026-10-10T00:00:00.000Z",
    method,
    turnId: mapperTurnId,
    ...overrides,
    payload,
  });
  const itemEvent = (
    method: "item/started" | "item/completed",
    item: Record<string, unknown>,
    overrides: Partial<ProviderEvent> = {},
  ) =>
    native(
      method,
      { threadId: "provider-thread", turnId: mapperTurnId, item },
      {
        itemId: asItemId(String(item.id)),
        ...overrides,
      },
    );
  const decodeRuntimeEvent = Schema.decodeUnknownSync(ProviderRuntimeEventSchema);
  const single = (events: ReadonlyArray<ProviderRuntimeEvent>): ProviderRuntimeEvent => {
    assert.equal(events.length, 1);
    decodeRuntimeEvent(events[0]);
    return events[0]!;
  };

  it("keeps the agentMessage phase and reports the last final answer on turn/completed", () => {
    const map = makeCodexRuntimeEventMapper();
    const commentary = single(
      map(
        itemEvent("item/completed", {
          type: "agentMessage",
          id: "msg-1",
          text: "Looking",
          phase: "commentary",
        }),
        mapperThreadId,
      ),
    );
    assert.equal(commentary.type, "item.completed");
    assert.equal(
      commentary.type === "item.completed" ? commentary.payload.phase : null,
      "commentary",
    );
    map(
      itemEvent("item/completed", {
        type: "agentMessage",
        id: "msg-2",
        text: "A",
        phase: "final_answer",
      }),
      mapperThreadId,
    );
    map(
      itemEvent("item/completed", {
        type: "agentMessage",
        id: "msg-3",
        text: "B",
        phase: "final_answer",
      }),
      mapperThreadId,
    );
    const completed = single(
      map(
        native("turn/completed", { turn: { id: mapperTurnId, status: "completed" } }),
        mapperThreadId,
      ),
    );
    assert.equal(completed.type, "turn.completed");
    assert.equal(
      completed.type === "turn.completed" ? completed.payload.finalAssistantItemId : null,
      "msg-3",
    );

    map(
      itemEvent("item/completed", { type: "agentMessage", id: "msg-4", text: "C" }),
      mapperThreadId,
    );
    const withoutPhase = single(
      map(
        native("turn/completed", { turn: { id: mapperTurnId, status: "completed" } }),
        mapperThreadId,
      ),
    );
    assert.equal(
      withoutPhase.type === "turn.completed" ? withoutPhase.payload.finalAssistantItemId : "x",
      undefined,
    );
  });

  it("reads the Synara turn origin and flags messages added in provider-started turns", () => {
    const map = makeCodexRuntimeEventMapper();
    const started = single(
      map(
        native("turn/started", { turn: { id: mapperTurnId }, synaraTurnOrigin: "provider" }),
        mapperThreadId,
      ),
    );
    assert.equal(started.type === "turn.started" ? started.payload.origin : null, "provider");
    const events = map(
      itemEvent("item/completed", {
        type: "userMessage",
        id: "user-1",
        clientId: null,
        content: [{ type: "text", text: "Continue the goal", text_elements: [] }],
      }),
      mapperThreadId,
    );
    const notice = events.find((event) => event.type === "transcript.notice");
    assert.equal(
      notice?.type === "transcript.notice" ? notice.payload.noticeKind : null,
      "user-message-injected",
    );
    assert.equal(
      notice?.type === "transcript.notice" ? notice.payload.body : null,
      "Continue the goal",
    );

    const userTurn = asTurnId("turn-user");
    map(
      native(
        "turn/started",
        { turn: { id: userTurn }, synaraTurnOrigin: "user" },
        { turnId: userTurn },
      ),
      mapperThreadId,
    );
    const echo = map(
      itemEvent(
        "item/completed",
        { type: "userMessage", id: "user-2", content: [{ type: "text", text: "hi" }] },
        { turnId: userTurn },
      ),
      mapperThreadId,
    );
    assert.deepEqual(
      echo.map((event) => event.type),
      ["item.completed"],
    );
  });

  it("emits typed command details with exact output, null exit codes, and a 20k tail", () => {
    const map = makeCodexRuntimeEventMapper();
    const base = {
      type: "commandExecution",
      id: "cmd-1",
      command: "printf '  x  '",
      cwd: "/repo",
      status: "completed",
      commandActions: [
        { type: "read", command: "cat a.ts", name: "a.ts", path: "src/a.ts" },
        { type: "listFiles", command: "ls", path: "src" },
        { type: "search", command: "rg foo", query: "foo", path: null },
      ],
      durationMs: 1250,
    };
    const whitespace = single(
      map(
        itemEvent("item/completed", { ...base, aggregatedOutput: "  \n ", exitCode: null }),
        mapperThreadId,
      ),
    );
    assert.equal(whitespace.type, "item.completed");
    if (whitespace.type !== "item.completed") return;
    assert.deepEqual(whitespace.payload.command, {
      command: "printf '  x  '",
      cwd: "/repo",
      exitCode: null,
      durationMs: 1250,
      output: "  \n ",
      outputTotalChars: 4,
      parsedActions: [
        { type: "read", command: "cat a.ts", name: "a.ts", path: "src/a.ts" },
        { type: "list_files", command: "ls", path: "src" },
        { type: "search", command: "rg foo", query: "foo" },
      ],
    });
    const data = whitespace.payload.data as { item: Record<string, unknown> };
    assert.equal("aggregatedOutput" in data.item, false);
    assert.equal(data.item.command, "printf '  x  '");

    const padded = single(
      map(
        itemEvent("item/completed", {
          ...base,
          id: "cmd-padded",
          aggregatedOutput: "  x  \n",
          exitCode: 0,
        }),
        mapperThreadId,
      ),
    );
    if (padded.type !== "item.completed") return assert.fail("expected item.completed");
    assert.equal(padded.payload.command?.output, "  x  \n");
    assert.equal(padded.payload.command?.outputTruncated, undefined);

    const long = `${"a".repeat(10_000)}${"b".repeat(20_000)}`;
    const truncated = single(
      map(
        itemEvent("item/completed", { ...base, id: "cmd-2", aggregatedOutput: long, exitCode: 2 }),
        mapperThreadId,
      ),
    );
    if (truncated.type !== "item.completed") return assert.fail("expected item.completed");
    assert.equal(truncated.payload.command?.output, "b".repeat(20_000));
    assert.equal(truncated.payload.command?.outputTruncated, true);
    assert.equal(truncated.payload.command?.outputTotalChars, 30_000);
    assert.equal(truncated.payload.command?.exitCode, 2);
    assert.equal(JSON.stringify(truncated).includes("a".repeat(100)), false);

    const started = single(
      map(
        itemEvent("item/started", { ...base, id: "cmd-3", aggregatedOutput: null, exitCode: null }),
        mapperThreadId,
      ),
    );
    if (started.type !== "item.started") return assert.fail("expected item.started");
    assert.equal(started.payload.command?.exitCode, undefined);
    assert.equal(started.payload.command?.output, undefined);
  });

  it("keeps the failure on a failed list command so parsed action labels can be ignored", () => {
    const map = makeCodexRuntimeEventMapper();
    const failed = single(
      map(
        itemEvent("item/completed", {
          type: "commandExecution",
          id: "cmd-ls-missing",
          command: "ls /nonexistent",
          cwd: "/repo",
          status: "failed",
          commandActions: [{ type: "listFiles", command: "ls /nonexistent", path: "/nonexistent" }],
          aggregatedOutput: "ls: /nonexistent: No such file or directory\n",
          exitCode: 1,
          durationMs: 12,
        }),
        mapperThreadId,
      ),
    );
    if (failed.type !== "item.completed") return assert.fail("expected item.completed");
    assert.equal(failed.payload.status, "failed");
    assert.equal(failed.payload.command?.exitCode, 1);
    assert.deepEqual(failed.payload.command?.parsedActions, [
      { type: "list_files", command: "ls /nonexistent", path: "/nonexistent" },
    ]);
  });

  it("does not split an emoji at the command output tail cut", () => {
    const map = makeCodexRuntimeEventMapper();
    const completed = single(
      map(
        itemEvent("item/completed", {
          type: "commandExecution",
          id: "cmd-emoji-tail",
          command: "cat emoji.txt",
          status: "completed",
          aggregatedOutput: `\u{1F600}${"x".repeat(TRANSCRIPT_OUTPUT_TAIL_MAX_CHARS - 1)}`,
          exitCode: 0,
        }),
        mapperThreadId,
      ),
    );
    if (completed.type !== "item.completed") return assert.fail("expected item.completed");
    assert.equal(
      completed.payload.command?.output,
      "x".repeat(TRANSCRIPT_OUTPUT_TAIL_MAX_CHARS - 1),
    );
    assert.equal(completed.payload.command?.outputTruncated, true);
  });

  it("maps rmcp transport stderr to one MCP notice per server and generation", () => {
    const map = makeCodexRuntimeEventMapper();
    const stderr = (message: string, lifecycleGeneration = "gen-1") =>
      native("process/stderr", {}, { kind: "error", message, lifecycleGeneration });
    const line =
      '2026-08-19T22:47:15.818164Z ERROR rmcp::transport::worker: worker quit with fatal: Transport channel closed, when AuthRequired(AuthRequiredError { www_authenticate_header: "Bearer resource_metadata=\\"https://mcp.example.com/.well-known/oauth\\"" })';
    const first = single(map(stderr(line), mapperThreadId));
    assert.equal(first.type, "transcript.notice");
    if (first.type !== "transcript.notice") return;
    const { noticeKind, severity, title, detail, status, dedupeKey } = first.payload;
    assert.deepEqual(
      { noticeKind, severity, title, detail, status, dedupeKey },
      {
        noticeKind: "mcp-server-status",
        severity: "warning",
        title: "MCP server at mcp.example.com transport error",
        detail: "Authentication required",
        status: "failed",
        dedupeKey: "mcp-transport:gen-1:mcp.example.com",
      },
    );
    assert.equal(first.payload.body?.startsWith("worker quit with fatal"), true);
    assert.equal(JSON.stringify(first.payload).includes("2026-08-19T22:47:15"), false);
    assert.deepEqual(map(stderr(line), mapperThreadId), []);
    assert.equal(single(map(stderr(line, "gen-2"), mapperThreadId)).type, "transcript.notice");

    const plain = single(map(stderr("write_stdin failed: stdin is closed"), mapperThreadId));
    assert.equal(plain.type, "runtime.warning");
  });

  it("keeps URL userinfo and query secrets out of MCP transport notices", () => {
    const map = makeCodexRuntimeEventMapper();
    const line =
      "2026-08-19T22:47:15Z ERROR rmcp::transport::streamable_http_client: error sending request for url (https://TOKEN@mcp.example.com/path?sig=abc)";
    const notice = single(
      map(
        native(
          "process/stderr",
          {},
          { kind: "error", message: line, lifecycleGeneration: "gen-1" },
        ),
        mapperThreadId,
      ),
    );
    if (notice.type !== "transcript.notice") return assert.fail("expected transcript.notice");
    assert.equal(notice.payload.title, "MCP server at mcp.example.com transport error");
    assert.equal(
      notice.payload.body,
      "error sending request for url (https://mcp.example.com/path?[REDACTED])",
    );
    const serialized = JSON.stringify(notice);
    assert.equal(serialized.includes("TOKEN"), false);
    assert.equal(serialized.includes("abc"), false);
  });

  it("never sends Codex session lifecycle methods to the generic provider event row", () => {
    const map = makeCodexRuntimeEventMapper();
    const session = (method: string) =>
      native(method, {}, { kind: "session", message: `${method} message` });
    const methods = [
      "session/connecting",
      "session/threadOpenRequested",
      "session/threadOpenResolved",
      "session/threadResumeFallback",
      "session/threadStartWithoutResume",
      "session/ready",
      "session/started",
      "session/closed",
      "session/exited",
    ];
    for (const method of methods) {
      const types = map(session(method), mapperThreadId).map((event) => event.type);
      assert.equal(types.includes("event.unmapped"), false, method);
    }
    assert.deepEqual(map(session("session/threadOpenResolved"), mapperThreadId), []);
    const fallback = single(map(session("session/threadResumeFallback"), mapperThreadId));
    if (fallback.type !== "transcript.notice") return assert.fail("expected transcript.notice");
    assert.deepEqual(
      [fallback.payload.noticeKind, fallback.payload.severity, fallback.payload.title],
      ["provider-warning", "warning", "Could not resume the Codex thread; started a new thread"],
    );
  });

  it("maps terminal input to the command row and redacts it", () => {
    const map = makeCodexRuntimeEventMapper();
    const updated = single(
      map(
        native(
          "item/commandExecution/terminalInteraction",
          { itemId: "cmd-1", processId: "p1", stdin: "password=hunter2\n" },
          { itemId: asItemId("cmd-1") },
        ),
        mapperThreadId,
      ),
    );
    if (updated.type !== "item.updated") return assert.fail("expected item.updated");
    assert.equal(updated.payload.itemType, "command_execution");
    assert.equal(updated.payload.command?.lastStdin?.includes("hunter2"), false);
  });

  it("emits per-file changes with diffs, counts, adds, and moves", () => {
    const map = makeCodexRuntimeEventMapper();
    const event = single(
      map(
        itemEvent("item/completed", {
          type: "fileChange",
          id: "patch-1",
          status: "completed",
          changes: [
            { path: "src/new.ts", kind: { type: "add" }, diff: "one\ntwo\n" },
            {
              path: "src/old.ts",
              kind: { type: "update", move_path: null },
              diff: "@@ -1,2 +1,2 @@\n-a\n+b\n c\n+d",
            },
            { path: "src/from.ts", kind: { type: "update", move_path: "src/to.ts" }, diff: "" },
          ],
        }),
        mapperThreadId,
      ),
    );
    if (event.type !== "item.completed") return assert.fail("expected item.completed");
    const changes = event.payload.fileChanges?.changes ?? [];
    assert.equal(event.payload.fileChanges?.totalFiles, 3);
    assert.deepEqual(changes[0], {
      path: "src/new.ts",
      kind: "add",
      unifiedDiff: "--- /dev/null\n+++ b/src/new.ts\n@@ -0,0 +1,2 @@\n+one\n+two",
      additions: 2,
      deletions: 0,
    });
    assert.equal(changes[1]?.kind, "update");
    assert.equal(changes[1]?.additions, 2);
    assert.equal(changes[1]?.deletions, 1);
    assert.equal(changes[2]?.kind, "move");
    assert.equal(changes[2]?.movePath, "src/to.ts");
    const data = event.payload.data as { item: { changes: Array<Record<string, unknown>> } };
    assert.deepEqual(data.item.changes[0], { path: "src/new.ts", kind: { type: "add" } });

    const patch = single(
      map(
        native(
          "item/fileChange/patchUpdated",
          {
            itemId: "patch-1",
            changes: [
              {
                path: "a.ts",
                kind: { type: "update", move_path: null },
                diff: "@@ -1 +1 @@\n-x\n+y",
              },
            ],
          },
          { itemId: asItemId("patch-1") },
        ),
        mapperThreadId,
      ),
    );
    if (patch.type !== "item.updated") return assert.fail("expected item.updated");
    assert.equal(patch.payload.itemType, "file_change");
    assert.equal(patch.payload.fileChanges?.changes[0]?.additions, 1);
  });

  it("emits MCP, dynamic, web search, and function output tool details", () => {
    const map = makeCodexRuntimeEventMapper();
    const mcp = single(
      map(
        itemEvent("item/completed", {
          type: "mcpToolCall",
          id: "mcp-1",
          server: "github",
          tool: "get_issue",
          status: "completed",
          arguments: { number: 7 },
          result: {
            content: [
              { type: "text", text: "Issue 7" },
              { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
            ],
            structuredContent: { number: 7 },
            _meta: null,
          },
          error: null,
          durationMs: 40,
        }),
        mapperThreadId,
      ),
    );
    if (mcp.type !== "item.completed") return assert.fail("expected item.completed");
    assert.equal(mcp.payload.toolName, "get_issue");
    assert.deepEqual(mcp.payload.toolCall, {
      toolName: "get_issue",
      server: "github",
      arguments: { number: 7 },
      resultText: "Issue 7",
      images: [
        {
          source: "omitted",
          mediaType: "image/png",
          byteLength: 6,
          reason: "Tool result images are not stored in the transcript yet.",
        },
      ],
      structuredContent: { number: 7 },
      success: true,
      durationMs: 40,
    });
    assert.equal("result" in (mcp.payload.data as { item: object }).item, false);

    const web = single(
      map(
        itemEvent("item/completed", {
          type: "webSearch",
          id: "web-1",
          query: "effect schema",
          action: { type: "findInPage", url: "https://effect.website", pattern: "Struct" },
          results: null,
        }),
        mapperThreadId,
      ),
    );
    if (web.type !== "item.completed") return assert.fail("expected item.completed");
    assert.deepEqual(web.payload.webSearch, {
      query: "effect schema",
      action: { type: "find_in_page", url: "https://effect.website", pattern: "Struct" },
    });

    const output = map(
      itemEvent("item/completed", {
        type: "functionCallOutput",
        id: "call-9",
        name: "lookup",
        namespace: null,
        output: [{ type: "input_text", text: "done" }],
      }),
      mapperThreadId,
    );
    const merged = single(output);
    if (merged.type !== "item.completed") return assert.fail("expected item.completed");
    assert.equal(merged.itemId, "call-9");
    assert.equal(merged.payload.itemType, "dynamic_tool_call");
    assert.equal(merged.payload.toolCall?.resultText, "done");
    assert.deepEqual(
      map(
        itemEvent("item/started", {
          type: "functionCallOutput",
          id: "call-9",
          name: "lookup",
          output: "",
        }),
        mapperThreadId,
      ),
      [],
    );
  });

  it("labels native MCP reauthentication so the transcript filter keeps it hidden", () => {
    const event = single(
      makeCodexRuntimeEventMapper()(
        native("mcpServer/startupStatus/updated", {
          name: "linear",
          status: "failed",
          failureReason: "reauthenticationRequired",
          error: "Sign in again",
        }),
        mapperThreadId,
      ),
    );
    if (event.type !== "transcript.notice") return assert.fail("expected notice");
    assert.equal(event.payload.title, "MCP server linear needs authentication");
  });

  it("dedupes skills and MCP startup notices per lifecycle generation", () => {
    const map = makeCodexRuntimeEventMapper();
    const skillsKey = (generation: string, tracker = new CodexTranscriptTracker()) => {
      const event = single(
        makeCodexRuntimeEventMapper(tracker)(
          native("skills/changed", {}, { lifecycleGeneration: generation }),
          mapperThreadId,
        ),
      );
      return event.type === "transcript.notice" ? event.payload.dedupeKey : undefined;
    };
    assert.equal(skillsKey("gen-1"), skillsKey("gen-1"));
    assert.notEqual(skillsKey("gen-1"), skillsKey("gen-2"));
    const skills = native("skills/changed", {}, { lifecycleGeneration: "gen-3" });
    assert.equal(map(skills, mapperThreadId).length, 1);
    assert.deepEqual(map({ ...skills, id: asEventId("evt-skills-repeat") }, mapperThreadId), []);

    const mcp = (name: string, status: string, error: string | null = null) =>
      single(
        map(
          native(
            "mcpServer/startupStatus/updated",
            { threadId: null, name, status, error, failureReason: null },
            { lifecycleGeneration: "gen-1" },
          ),
          mapperThreadId,
        ),
      );
    assert.deepEqual(
      map(
        native("mcpServer/startupStatus/updated", { name: "a", status: "starting" }),
        mapperThreadId,
      ),
      [],
    );
    mcp("alpha", "ready");
    const ready = mcp("beta", "ready");
    if (ready.type !== "transcript.notice") return assert.fail("expected notice");
    assert.equal(ready.payload.title, "MCP servers ready: alpha, beta");
    assert.equal(ready.payload.dedupeKey, "mcp:gen-1");
    const failed = mcp("gamma", "failed", "spawn ENOENT");
    if (failed.type !== "transcript.notice") return assert.fail("expected notice");
    assert.equal(failed.payload.severity, "warning");
    assert.equal(failed.payload.dedupeKey, "mcp:gen-1:gamma");
    assert.equal(failed.payload.detail, "spawn ENOENT");
  });

  it("maps auto-approval reviews to one upserted notice", () => {
    const map = makeCodexRuntimeEventMapper();
    const action = { type: "command", source: "shell", command: "rm -rf build", cwd: "/repo" };
    const started = single(
      map(
        native("item/autoApprovalReview/started", {
          reviewId: "rev-1",
          targetItemId: "cmd-1",
          startedAtMs: 1,
          review: { status: "inProgress" },
          action,
        }),
        mapperThreadId,
      ),
    );
    const denied = single(
      map(
        native("item/autoApprovalReview/completed", {
          reviewId: "rev-1",
          targetItemId: "cmd-1",
          startedAtMs: 1,
          completedAtMs: 2,
          decisionSource: "agent",
          review: { status: "denied", rationale: "Deletes the build output" },
          action,
        }),
        mapperThreadId,
      ),
    );
    if (started.type !== "transcript.notice" || denied.type !== "transcript.notice") {
      return assert.fail("expected notices");
    }
    assert.equal(started.payload.title, "Reviewing rm -rf build");
    assert.equal(started.payload.dedupeKey, denied.payload.dedupeKey);
    assert.equal(denied.payload.severity, "warning");
    assert.equal(denied.payload.title, "Denied rm -rf build");
    assert.equal(denied.payload.detail, "Deletes the build output");
  });

  it("keeps one review-mode notice when the review spans turns", () => {
    const map = makeCodexRuntimeEventMapper();
    const entered = map(
      itemEvent("item/completed", { type: "enteredReviewMode", id: "review-in", review: "main" }),
      mapperThreadId,
    ).find((event) => event.type === "transcript.notice");
    const exited = map(
      itemEvent(
        "item/completed",
        { type: "exitedReviewMode", id: "review-out", review: "Looks good" },
        { turnId: asTurnId("turn-review-2") },
      ),
      mapperThreadId,
    ).find((event) => event.type === "transcript.notice");
    if (entered?.type !== "transcript.notice" || exited?.type !== "transcript.notice") {
      return assert.fail("expected review notices");
    }
    assert.equal(entered.payload.title, "Started review: main");
    assert.equal(exited.payload.status, "completed");
    assert.equal(entered.payload.dedupeKey, exited.payload.dedupeKey);
  });

  it("maps warnings to capped, redacted provider-warning notices", () => {
    const map = makeCodexRuntimeEventMapper();
    const message = `token=abc123 ${"x".repeat(400)}`;
    const warning = single(map(native("warning", { threadId: null, message }), mapperThreadId));
    if (warning.type !== "transcript.notice") return assert.fail("expected notice");
    assert.equal(warning.payload.noticeKind, "provider-warning");
    assert.ok(warning.payload.title.length <= 200);
    assert.equal(JSON.stringify(warning).includes("abc123"), false);
    assert.deepEqual(warning.raw?.payload, { synaraSanitized: true });
    assert.deepEqual(
      map(native("turn/moderationMetadata", { metadata: { model: "x" } }), mapperThreadId),
      [],
    );
  });

  it("parses Codex reconnect progress into retry fields", () => {
    const map = makeCodexRuntimeEventMapper();
    const warning = single(
      map(
        native("error", {
          error: { message: "Reconnecting... 2/5", codexErrorInfo: null, additionalDetails: null },
          willRetry: true,
        }),
        mapperThreadId,
      ),
    );
    if (warning.type !== "runtime.warning") return assert.fail("expected runtime.warning");
    assert.equal(warning.payload.retryAttempt, 2);
    assert.equal(warning.payload.retryMaxAttempts, 5);
  });

  it("refuses gated requests and ignored state notifications without events", () => {
    const map = makeCodexRuntimeEventMapper();
    for (const method of [
      "item/tool/call",
      "account/chatgptAuthTokens/refresh",
      "attestation/generate",
    ]) {
      assert.deepEqual(
        map(native(method, { callId: "c" }, { kind: "request" }), mapperThreadId),
        [],
      );
    }
    assert.deepEqual(
      map(native("thread/goal/updated", { goal: { objective: "x" } }), mapperThreadId),
      [],
    );
    assert.deepEqual(
      map(native("item/reasoning/summaryPartAdded", { summaryIndex: 1 }), mapperThreadId),
      [],
    );
  });
});
