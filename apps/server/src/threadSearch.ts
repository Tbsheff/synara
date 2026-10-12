// FILE: threadSearch.ts
// Purpose: Message-content search over persisted chat history for the sidebar palette.
// The web client only keeps message bodies for recently opened threads, so this
// read covers every live thread regardless of what a client has hydrated.
// Layer: server read query service (SqlClient). Available in Stable and Beta.

import {
  MessageId,
  ORCHESTRATION_SEARCH_THREADS_MAX_EXCERPT_LENGTH,
  ORCHESTRATION_SEARCH_THREADS_MAX_LIMIT,
  type OrchestrationSearchThreadsInput,
  type OrchestrationSearchThreadsResult,
  type OrchestrationThreadSearchMatch,
  ThreadId,
} from "@synara/contracts";
import { Effect, Layer, ServiceMap } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  PersistenceDecodeError,
  type PersistenceSqlError,
  toPersistenceSqlError,
} from "./persistence/Errors.ts";

const DEFAULT_LIMIT = 20;
// The RPC schema bounds the whole query to 200 characters; never discard
// words here because every distinct token must match.
const EXCERPT_CONTEXT_BEFORE = 80;
const ELLIPSIS = "...";

export const THREAD_SEARCH_MESSAGE_BUDGET = 4_000;
const THREAD_PAGE_SIZE = 200;

interface CandidateThreadRow {
  readonly threadId: string;
  readonly updatedAt: string;
  readonly archived: number;
  readonly messageCount: number;
}

interface ThreadHitRow {
  readonly threadId: string;
  readonly messageId: string;
  readonly roleRank: number;
  readonly createdAt: string;
  readonly body: string;
  readonly matchCount: number;
}

interface MessageKeyRow {
  readonly createdAt: string;
  readonly rowId: number;
}

interface ThreadCursor {
  readonly updatedAt: string;
  readonly threadId: string;
}

function normalizeWhitespace(value: string): string {
  return value.trim().replaceAll(/\s+/g, " ");
}

export function tokenizeThreadSearchQuery(query: string): string[] {
  const tokens = normalizeWhitespace(query)
    .toLowerCase()
    .split(" ")
    .filter((token) => token.length > 0);
  return [...new Set(tokens)];
}

/** A window around the phrase (or earliest token) so the client can build its own snippet. */
export function buildThreadSearchExcerpt(
  text: string,
  query: string,
  tokens: readonly string[],
): string {
  const display = normalizeWhitespace(text);
  const maxBody = ORCHESTRATION_SEARCH_THREADS_MAX_EXCERPT_LENGTH - ELLIPSIS.length * 2;
  if (display.length <= ORCHESTRATION_SEARCH_THREADS_MAX_EXCERPT_LENGTH) {
    return display;
  }
  const lower = display.toLowerCase();
  let hitIndex = lower.indexOf(normalizeWhitespace(query).toLowerCase());
  if (hitIndex < 0) {
    const tokenIndexes = tokens.map((token) => lower.indexOf(token)).filter((index) => index >= 0);
    hitIndex = tokenIndexes.length > 0 ? Math.min(...tokenIndexes) : 0;
  }
  const start = Math.min(
    Math.max(0, hitIndex - EXCERPT_CONTEXT_BEFORE),
    Math.max(0, display.length - maxBody),
  );
  const end = Math.min(display.length, start + maxBody);
  const prefix = start > 0 ? ELLIPSIS : "";
  const suffix = end < display.length ? ELLIPSIS : "";
  return `${prefix}${display.slice(start, end).trim()}${suffix}`;
}

export function encodeThreadSearchCursor(cursor: ThreadCursor): string {
  return Buffer.from(JSON.stringify([cursor.updatedAt, cursor.threadId]), "utf8").toString(
    "base64url",
  );
}

export function decodeThreadSearchCursor(value: string): ThreadCursor | null {
  try {
    const decoded: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (
      Array.isArray(decoded) &&
      decoded.length === 2 &&
      typeof decoded[0] === "string" &&
      typeof decoded[1] === "string"
    ) {
      return { updatedAt: decoded[0], threadId: decoded[1] };
    }
  } catch {
    return null;
  }
  return null;
}

export function planThreadSearchBatches<T extends { readonly messageCount: number }>(
  threads: ReadonlyArray<T>,
  budget: number,
): Array<
  { readonly kind: "batch"; readonly threads: T[] } | { readonly kind: "large"; readonly thread: T }
> {
  const plan: Array<
    | { readonly kind: "batch"; readonly threads: T[] }
    | { readonly kind: "large"; readonly thread: T }
  > = [];
  let batch: T[] = [];
  let batchMessages = 0;
  const flush = () => {
    if (batch.length > 0) {
      plan.push({ kind: "batch", threads: batch });
      batch = [];
      batchMessages = 0;
    }
  };
  for (const thread of threads) {
    if (thread.messageCount > budget) {
      flush();
      plan.push({ kind: "large", thread });
      continue;
    }
    if (batchMessages + thread.messageCount > budget) {
      flush();
    }
    batch.push(thread);
    batchMessages += thread.messageCount;
  }
  flush();
  return plan;
}

function isBetterHit(candidate: ThreadHitRow, current: ThreadHitRow | undefined): boolean {
  if (current === undefined) return true;
  if (candidate.roleRank !== current.roleRank) return candidate.roleRank < current.roleRank;
  if (candidate.createdAt !== current.createdAt) return candidate.createdAt > current.createdAt;
  return candidate.messageId < current.messageId;
}

export interface ThreadSearchQueryShape {
  readonly searchThreads: (
    input: OrchestrationSearchThreadsInput,
  ) => Effect.Effect<
    OrchestrationSearchThreadsResult,
    PersistenceSqlError | PersistenceDecodeError
  >;
}

export class ThreadSearchQuery extends ServiceMap.Service<
  ThreadSearchQuery,
  ThreadSearchQueryShape
>()("synara/threadSearch/ThreadSearchQuery") {}

export const makeThreadSearchQuery = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const mapSqlError = Effect.mapError(toPersistenceSqlError("ThreadSearchQuery.searchThreads"));

  const searchThreads: ThreadSearchQueryShape["searchThreads"] = (input) =>
    Effect.gen(function* () {
      const tokens = tokenizeThreadSearchQuery(input.query);
      if (tokens.length === 0) {
        return { matches: [] };
      }
      const limit = Math.min(input.limit ?? DEFAULT_LIMIT, ORCHESTRATION_SEARCH_THREADS_MAX_LIMIT);
      const includeArchived = input.includeArchived === true;
      let cursor: ThreadCursor | null = null;
      if (input.cursor !== undefined) {
        cursor = decodeThreadSearchCursor(input.cursor);
        if (cursor === null) {
          return yield* new PersistenceDecodeError({
            operation: "ThreadSearchQuery.searchThreads:cursor",
            issue: "The search cursor is not valid.",
          });
        }
      }
      // Settled bodies live in `text`, or JSON-encoded in `text_json` when they
      // carry NULs or lone surrogates; streaming rows are skipped.
      // Literal substring matching avoids wildcard interpretation and LIKE's
      // truncation at NUL in decoded persisted bodies. SQLite lower remains
      // ASCII-only, matching the existing search case-folding contract.
      const tokenPredicates = sql.join(
        " AND ",
        false,
      )(
        tokens.map(
          (token) =>
            sql`instr(lower(COALESCE(json_extract(messages.text_json, '$'), messages.text)), ${token}) > 0`,
        ),
      );
      const eligibleMessages = sql`
        messages.is_streaming = 0
        AND messages.role IN ('user', 'assistant')
        AND ${tokenPredicates}
      `;

      const listCandidateThreads = (after: ThreadCursor | null) =>
        sql<CandidateThreadRow>`
          SELECT
            threads.thread_id AS "threadId",
            threads.updated_at AS "updatedAt",
            threads.archived_at IS NOT NULL AS "archived",
            (
              SELECT COUNT(*)
              FROM projection_thread_messages AS counted
              WHERE counted.thread_id = threads.thread_id
            ) AS "messageCount"
          FROM projection_threads AS threads
          INNER JOIN projection_projects AS projects
            ON projects.project_id = threads.project_id
          WHERE threads.deleted_at IS NULL
            ${includeArchived ? sql`` : sql`AND threads.archived_at IS NULL`}
            AND threads.parent_thread_id IS NULL
            AND projects.deleted_at IS NULL
            ${
              after === null
                ? sql``
                : sql`AND (threads.updated_at < ${after.updatedAt}
                    OR (threads.updated_at = ${after.updatedAt} AND threads.thread_id > ${after.threadId}))`
            }
          ORDER BY threads.updated_at DESC, threads.thread_id
          LIMIT ${THREAD_PAGE_SIZE}
        `.pipe(mapSqlError);

      const searchThreadBatch = (threadIds: ReadonlyArray<string>) =>
        sql<ThreadHitRow>`
          WITH hits AS (
            SELECT
              messages.thread_id,
              messages.message_id,
              CASE messages.role WHEN 'user' THEN 0 ELSE 1 END AS role_rank,
              messages.created_at,
              COALESCE(json_extract(messages.text_json, '$'), messages.text) AS body
            FROM projection_thread_messages AS messages
            WHERE messages.thread_id IN ${sql.in(threadIds)}
              AND ${eligibleMessages}
          ),
          ranked AS (
            SELECT
              *,
              COUNT(*) OVER (PARTITION BY thread_id) AS match_count,
              ROW_NUMBER() OVER (
                PARTITION BY thread_id
                ORDER BY role_rank, created_at DESC, message_id
              ) AS thread_rank
            FROM hits
          )
          SELECT
            thread_id AS "threadId",
            message_id AS "messageId",
            role_rank AS "roleRank",
            created_at AS "createdAt",
            body,
            match_count AS "matchCount"
          FROM ranked
          WHERE thread_rank = 1
        `.pipe(mapSqlError);

      const searchLargeThread = (threadId: string) =>
        Effect.gen(function* () {
          let best: ThreadHitRow | undefined;
          let matchCount = 0;
          let upper: MessageKeyRow | null = null;
          while (true) {
            const upperBound: MessageKeyRow | null = upper;
            const keyRange =
              upperBound === null
                ? sql``
                : sql`AND (messages.created_at, messages.rowid) < (${upperBound.createdAt}, ${upperBound.rowId})`;
            const [lower] = yield* sql<MessageKeyRow>`
              SELECT messages.created_at AS "createdAt", messages.rowid AS "rowId"
              FROM projection_thread_messages AS messages
              WHERE messages.thread_id = ${threadId}
                ${keyRange}
              ORDER BY messages.created_at DESC, messages.rowid DESC
              LIMIT 1 OFFSET ${THREAD_SEARCH_MESSAGE_BUDGET - 1}
            `.pipe(mapSqlError);
            const lowerRange =
              lower === undefined
                ? sql``
                : sql`AND (messages.created_at, messages.rowid) >= (${lower.createdAt}, ${lower.rowId})`;
            const [hit] = yield* sql<ThreadHitRow>`
              SELECT
                messages.thread_id AS "threadId",
                messages.message_id AS "messageId",
                CASE messages.role WHEN 'user' THEN 0 ELSE 1 END AS "roleRank",
                messages.created_at AS "createdAt",
                COALESCE(json_extract(messages.text_json, '$'), messages.text) AS body,
                COUNT(*) OVER () AS "matchCount"
              FROM projection_thread_messages AS messages
              WHERE messages.thread_id = ${threadId}
                ${keyRange}
                ${lowerRange}
                AND ${eligibleMessages}
              ORDER BY "roleRank", messages.created_at DESC, messages.message_id
              LIMIT 1
            `.pipe(mapSqlError);
            if (hit !== undefined) {
              matchCount += hit.matchCount;
              if (isBetterHit(hit, best)) best = hit;
            }
            if (lower === undefined) break;
            upper = lower;
            yield* Effect.yieldNow;
          }
          return best === undefined ? undefined : { ...best, matchCount };
        });

      const matches: OrchestrationThreadSearchMatch[] = [];
      let after = cursor;
      while (true) {
        const page = yield* listCandidateThreads(after);
        for (const step of planThreadSearchBatches(page, THREAD_SEARCH_MESSAGE_BUDGET)) {
          const stepThreads = step.kind === "batch" ? step.threads : [step.thread];
          const hits = new Map<string, ThreadHitRow>();
          if (step.kind === "batch") {
            const nonEmpty = step.threads.filter((thread) => thread.messageCount > 0);
            if (nonEmpty.length > 0) {
              for (const hit of yield* searchThreadBatch(
                nonEmpty.map((thread) => thread.threadId),
              )) {
                hits.set(hit.threadId, hit);
              }
            }
          } else {
            const hit = yield* searchLargeThread(step.thread.threadId);
            if (hit !== undefined) hits.set(hit.threadId, hit);
          }
          for (const thread of stepThreads) {
            const hit = hits.get(thread.threadId);
            if (hit === undefined) continue;
            matches.push({
              threadId: ThreadId.makeUnsafe(hit.threadId),
              excerpt: buildThreadSearchExcerpt(hit.body, input.query, tokens),
              matchCount: hit.matchCount,
              messageId: MessageId.makeUnsafe(hit.messageId),
              archived: thread.archived !== 0,
            });
            if (matches.length >= limit) {
              return {
                matches,
                nextCursor: encodeThreadSearchCursor({
                  updatedAt: thread.updatedAt,
                  threadId: thread.threadId,
                }),
              };
            }
          }
          yield* Effect.yieldNow;
        }
        const last = page.at(-1);
        if (page.length < THREAD_PAGE_SIZE || last === undefined) {
          return { matches };
        }
        after = { updatedAt: last.updatedAt, threadId: last.threadId };
      }
    });

  return { searchThreads } satisfies ThreadSearchQueryShape;
});

export const ThreadSearchQueryLive = Layer.effect(ThreadSearchQuery, makeThreadSearchQuery);
