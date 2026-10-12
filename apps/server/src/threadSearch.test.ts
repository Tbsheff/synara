// FILE: threadSearch.test.ts
// Purpose: Focused coverage for the palette's message-content search SQL against the migrated SQLite schema.
// Layer: Server read query tests

import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Fiber, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";

import { SqlitePersistenceMemory } from "./persistence/Layers/Sqlite";
import {
  buildThreadSearchExcerpt,
  planThreadSearchBatches,
  THREAD_SEARCH_MESSAGE_BUDGET,
  ThreadSearchQuery,
  ThreadSearchQueryLive,
} from "./threadSearch";

function runSearchTest<A, E>(effect: Effect.Effect<A, E, ThreadSearchQuery | SqlClient.SqlClient>) {
  const layer = ThreadSearchQueryLive.pipe(
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provide(NodeServices.layer),
  );
  return effect.pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise);
}

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO projection_projects (
      project_id, title, workspace_root, scripts_json, kind, created_at, updated_at, deleted_at
    )
    VALUES
      ('project-app', 'App', '/work/app', '{}', 'project',
        '2026-09-01T09:00:00.000Z', '2026-09-01T09:00:00.000Z', NULL),
      ('project-gone', 'Gone', '/work/gone', '{}', 'project',
        '2026-09-01T09:00:00.000Z', '2026-09-01T09:00:00.000Z', '2026-09-02T09:00:00.000Z')
  `;
  yield* sql`
    INSERT INTO projection_threads (
      thread_id, project_id, title, model_selection_json, runtime_mode,
      interaction_mode, env_mode, created_at, updated_at, deleted_at, archived_at, parent_thread_id
    )
    VALUES
      ('thread-old', 'project-app', 'Old', '{"provider":"codex","model":"gpt-5-codex"}',
        'full-access', 'default', 'local',
        '2026-01-01T09:00:00.000Z', '2026-01-02T09:00:00.000Z', NULL, NULL, NULL),
      ('thread-new', 'project-app', 'New', '{"provider":"codex","model":"gpt-5-codex"}',
        'full-access', 'default', 'local',
        '2026-09-01T09:00:00.000Z', '2026-09-03T09:00:00.000Z', NULL, NULL, NULL),
      ('thread-archived', 'project-app', 'Archived', '{"provider":"codex","model":"gpt-5-codex"}',
        'full-access', 'default', 'local',
        '2026-09-01T09:00:00.000Z', '2026-09-03T09:00:00.000Z', NULL, '2026-09-04T09:00:00.000Z', NULL),
      ('thread-deleted', 'project-app', 'Deleted', '{"provider":"codex","model":"gpt-5-codex"}',
        'full-access', 'default', 'local',
        '2026-09-01T09:00:00.000Z', '2026-09-03T09:00:00.000Z', '2026-09-04T09:00:00.000Z', NULL, NULL),
      ('thread-child', 'project-app', 'Child', '{"provider":"codex","model":"gpt-5-codex"}',
        'full-access', 'default', 'local',
        '2026-09-01T09:00:00.000Z', '2026-09-03T09:00:00.000Z', NULL, NULL, 'thread-new'),
      ('thread-gone-project', 'project-gone', 'Gone', '{"provider":"codex","model":"gpt-5-codex"}',
        'full-access', 'default', 'local',
        '2026-09-01T09:00:00.000Z', '2026-09-03T09:00:00.000Z', NULL, NULL, NULL)
  `;
  yield* sql`
    INSERT INTO projection_thread_messages (
      message_id, thread_id, turn_id, role, text, is_streaming, source, created_at, updated_at
    )
    VALUES
      ('m-old-1', 'thread-old', NULL, 'assistant', 'The Refund webhook retries three times', 0, 'native',
        '2026-01-01T09:00:00.000Z', '2026-01-01T09:00:00.000Z'),
      ('m-old-2', 'thread-old', NULL, 'user', 'why does the refund webhook fail?', 0, 'native',
        '2026-01-01T08:00:00.000Z', '2026-01-01T08:00:00.000Z'),
      ('m-new-1', 'thread-new', NULL, 'assistant', 'webhook for refund is wired', 0, 'native',
        '2026-09-02T09:00:00.000Z', '2026-09-02T09:00:00.000Z'),
      ('m-new-2', 'thread-new', NULL, 'assistant', 'refund webhook still streaming', 1, 'native',
        '2026-09-02T10:00:00.000Z', '2026-09-02T10:00:00.000Z'),
      ('m-new-3', 'thread-new', NULL, 'system', 'refund webhook system note', 0, 'native',
        '2026-09-02T11:00:00.000Z', '2026-09-02T11:00:00.000Z'),
      ('m-archived', 'thread-archived', NULL, 'user', 'refund webhook', 0, 'native',
        '2026-09-02T09:00:00.000Z', '2026-09-02T09:00:00.000Z'),
      ('m-deleted', 'thread-deleted', NULL, 'user', 'refund webhook', 0, 'native',
        '2026-09-02T09:00:00.000Z', '2026-09-02T09:00:00.000Z'),
      ('m-child', 'thread-child', NULL, 'user', 'refund webhook', 0, 'native',
        '2026-09-02T09:00:00.000Z', '2026-09-02T09:00:00.000Z'),
      ('m-gone', 'thread-gone-project', NULL, 'user', 'refund webhook', 0, 'native',
        '2026-09-02T09:00:00.000Z', '2026-09-02T09:00:00.000Z'),
      ('m-like', 'thread-old', NULL, 'assistant', 'progress at 100% done', 0, 'native',
        '2026-01-01T10:00:00.000Z', '2026-01-01T10:00:00.000Z')
  `;
});

describe("ThreadSearchQuery", () => {
  it("returns one match per live top-level thread, newest thread first", async () => {
    const result = await runSearchTest(
      Effect.gen(function* () {
        yield* seed;
        const search = yield* ThreadSearchQuery;
        return yield* search.searchThreads({ query: "Refund  WEBHOOK" });
      }),
    );

    expect(result.matches).toEqual([
      {
        threadId: "thread-new",
        excerpt: "webhook for refund is wired",
        matchCount: 1,
        messageId: "m-new-1",
        archived: false,
      },
      {
        threadId: "thread-old",
        excerpt: "why does the refund webhook fail?",
        matchCount: 2,
        messageId: "m-old-2",
        archived: false,
      },
    ]);
  });

  it("requires every token even beyond the first eight", async () => {
    const result = await runSearchTest(
      Effect.gen(function* () {
        yield* seed;
        const sql = yield* SqlClient.SqlClient;
        yield* sql`
          UPDATE projection_thread_messages
          SET text = 'one two three four five six seven eight present'
          WHERE message_id = 'm-new-1'
        `;
        const search = yield* ThreadSearchQuery;
        return {
          missing: yield* search.searchThreads({
            query: "one two three four five six seven eight absent",
          }),
          matching: yield* search.searchThreads({
            query: "one two three four five six seven eight present",
          }),
        };
      }),
    );
    expect(result.missing.matches).toEqual([]);
    expect(result.matching.matches.map((match) => match.threadId)).toEqual(["thread-new"]);
  });

  it("treats LIKE wildcards in the query literally and honors the limit", async () => {
    const result = await runSearchTest(
      Effect.gen(function* () {
        yield* seed;
        const search = yield* ThreadSearchQuery;
        return {
          percent: yield* search.searchThreads({ query: "100%" }),
          wildcard: yield* search.searchThreads({ query: "1_0" }),
          limited: yield* search.searchThreads({ query: "webhook", limit: 1 }),
        };
      }),
    );

    expect(result.percent.matches.map((match) => match.threadId)).toEqual(["thread-old"]);
    expect(result.wildcard.matches).toEqual([]);
    expect(result.limited.matches.map((match) => match.threadId)).toEqual(["thread-new"]);
  });

  it.each(["needle", "body"])(
    "reads JSON-encoded bodies on either side of NUL: %s",
    async (query) => {
      const result = await runSearchTest(
        Effect.gen(function* () {
          yield* seed;
          const sql = yield* SqlClient.SqlClient;
          yield* sql`
          UPDATE projection_thread_messages
          SET text = '', text_json = ${JSON.stringify("encoded needle\u0000body")}
          WHERE message_id = 'm-new-1'
        `;
          const search = yield* ThreadSearchQuery;
          return yield* search.searchThreads({ query });
        }),
      );

      expect(result.matches.map((match) => match.threadId)).toEqual(["thread-new"]);
    },
  );
});

const seedBulkThreads = (input: {
  readonly threads: number;
  readonly messagesPerThread: number;
  readonly prefix: string;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ${input.threads - 1})
      INSERT INTO projection_threads (
        thread_id, project_id, title, model_selection_json, runtime_mode,
        interaction_mode, env_mode, created_at, updated_at, deleted_at, archived_at, parent_thread_id
      )
      SELECT ${input.prefix} || '-' || i, 'project-app', 'Bulk', '{"provider":"codex","model":"gpt-5-codex"}',
        'full-access', 'default', 'local', '2026-03-01T00:00:00.000Z',
        strftime('%Y-%m-%dT%H:%M:%fZ', '2026-03-01', '+' || i || ' minutes'), NULL, NULL, NULL
      FROM n
    `;
    yield* sql`
      WITH RECURSIVE n(i) AS (
        SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ${input.threads * input.messagesPerThread - 1}
      )
      INSERT INTO projection_thread_messages (
        message_id, thread_id, turn_id, role, text, is_streaming, source, created_at, updated_at
      )
      SELECT ${input.prefix} || '-m-' || i,
        ${input.prefix} || '-' || CAST(i % ${input.threads} AS INTEGER), NULL, 'assistant',
        'bulk refund webhook body ' || i, 0, 'native',
        strftime('%Y-%m-%dT%H:%M:%fZ', '2026-03-01', '+' || i || ' seconds'), '2026-03-01T00:00:00.000Z'
      FROM n
    `;
  });

describe("ThreadSearchQuery bounded scan", () => {
  it("lets a write run between search statements instead of after the whole scan", async () => {
    const order = await runSearchTest(
      Effect.gen(function* () {
        yield* seed;
        yield* seedBulkThreads({
          threads: 30,
          messagesPerThread: Math.ceil((THREAD_SEARCH_MESSAGE_BUDGET * 3) / 30),
          prefix: "bulk",
        });
        const sql = yield* SqlClient.SqlClient;
        const search = yield* ThreadSearchQuery;
        const events: string[] = [];
        const searchFiber = yield* Effect.forkChild(
          search
            .searchThreads({ query: "absent-token", limit: 50 })
            .pipe(Effect.tap(() => Effect.sync(() => events.push("search")))),
        );
        const writeFiber = yield* Effect.forkChild(
          sql`UPDATE projection_threads SET title = 'Renamed' WHERE thread_id = 'thread-new'`.pipe(
            Effect.tap(() => Effect.sync(() => events.push("write"))),
          ),
        );
        yield* Fiber.join(searchFiber);
        yield* Fiber.join(writeFiber);
        return events;
      }),
    );

    expect(order).toEqual(["write", "search"]);
  });

  it("pages with a cursor and stops scanning once the limit is met", async () => {
    const pages = await runSearchTest(
      Effect.gen(function* () {
        yield* seedBulkThreads({ threads: 5, messagesPerThread: 2, prefix: "page" });
        yield* seed;
        const search = yield* ThreadSearchQuery;
        const first = yield* search.searchThreads({ query: "refund webhook", limit: 3 });
        const second = yield* search.searchThreads({
          query: "refund webhook",
          limit: 3,
          ...(first.nextCursor !== undefined ? { cursor: first.nextCursor } : {}),
        });
        const third = yield* search.searchThreads({
          query: "refund webhook",
          limit: 3,
          ...(second.nextCursor !== undefined ? { cursor: second.nextCursor } : {}),
        });
        return [first, second, third];
      }),
    );

    const ids = pages.flatMap((page) => page.matches.map((match) => match.threadId));
    expect(ids).toEqual([
      "thread-new",
      "page-4",
      "page-3",
      "page-2",
      "page-1",
      "page-0",
      "thread-old",
    ]);
    expect(pages[0]?.nextCursor).toBeDefined();
    expect(pages[1]?.nextCursor).toBeDefined();
    expect(pages[2]?.nextCursor).toBeUndefined();
  });

  it("includes archived threads only when asked and flags them", async () => {
    const result = await runSearchTest(
      Effect.gen(function* () {
        yield* seed;
        const search = yield* ThreadSearchQuery;
        return {
          live: yield* search.searchThreads({ query: "refund webhook" }),
          withArchived: yield* search.searchThreads({
            query: "refund webhook",
            includeArchived: true,
          }),
        };
      }),
    );

    expect(result.live.matches.map((match) => match.threadId)).not.toContain("thread-archived");
    expect(result.withArchived.matches.map((match) => [match.threadId, match.archived])).toEqual([
      ["thread-archived", true],
      ["thread-new", false],
      ["thread-old", false],
    ]);
  });

  it("scans a thread larger than the budget in chunks and keeps the best hit and full count", async () => {
    const result = await runSearchTest(
      Effect.gen(function* () {
        yield* seed;
        yield* seedBulkThreads({
          threads: 1,
          messagesPerThread: THREAD_SEARCH_MESSAGE_BUDGET * 2 + 10,
          prefix: "giant",
        });
        const sql = yield* SqlClient.SqlClient;
        yield* sql`
          UPDATE projection_thread_messages SET created_at = '2026-03-01T00:00:00.000Z'
          WHERE thread_id = 'giant-0'
        `;
        yield* sql`
          UPDATE projection_thread_messages
          SET role = 'user', text = 'oldest user note about the refund webhook'
          WHERE message_id = 'giant-m-0'
        `;
        yield* sql`
          UPDATE projection_threads SET updated_at = '2026-12-01T00:00:00.000Z'
          WHERE thread_id = 'giant-0'
        `;
        const search = yield* ThreadSearchQuery;
        return yield* search.searchThreads({ query: "refund webhook", limit: 1 });
      }),
    );

    expect(result.matches).toEqual([
      {
        threadId: "giant-0",
        excerpt: "oldest user note about the refund webhook",
        matchCount: THREAD_SEARCH_MESSAGE_BUDGET * 2 + 10,
        messageId: "giant-m-0",
        archived: false,
      },
    ]);
  });

  it("rejects a cursor it did not issue", async () => {
    const error = await runSearchTest(
      Effect.gen(function* () {
        const search = yield* ThreadSearchQuery;
        return yield* search
          .searchThreads({ query: "refund", cursor: "not-a-cursor" })
          .pipe(Effect.flip);
      }),
    );

    expect(error._tag).toBe("PersistenceDecodeError");
  });

  it("plans statements within the message budget", () => {
    const plan = planThreadSearchBatches(
      [
        { id: "a", messageCount: 3 },
        { id: "b", messageCount: 4 },
        { id: "c", messageCount: 12 },
        { id: "d", messageCount: 5 },
      ],
      8,
    );
    expect(
      plan.map((step) =>
        step.kind === "batch" ? step.threads.map((thread) => thread.id) : `large:${step.thread.id}`,
      ),
    ).toEqual([["a", "b"], "large:c", ["d"]]);
  });
});

describe("buildThreadSearchExcerpt", () => {
  it("windows long bodies around the first hit", () => {
    const text = `${"lead ".repeat(200)}the needle sits here ${"tail ".repeat(200)}`;
    const excerpt = buildThreadSearchExcerpt(text, "needle", ["needle"]);

    expect(excerpt.length).toBeLessThanOrEqual(320);
    expect(excerpt.startsWith("...")).toBe(true);
    expect(excerpt.endsWith("...")).toBe(true);
    expect(excerpt).toContain("the needle sits here");
  });
});
