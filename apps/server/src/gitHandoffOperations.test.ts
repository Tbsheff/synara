import { CommandId, ThreadId } from "@synara/contracts";
import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  beginGitHandoff,
  recordGitHandoffResult,
  recoverGitHandoffOperations,
} from "./gitHandoffOperations.ts";
import { SqlitePersistenceMemory } from "./persistence/Layers/Sqlite.ts";

const layer = it.layer(SqlitePersistenceMemory);

const input = {
  commandId: CommandId.makeUnsafe("git-handoff-recovery-command"),
  threadId: ThreadId.makeUnsafe("git-handoff-recovery-thread"),
  cwd: "/repo",
  targetMode: "worktree" as const,
  currentBranch: "main",
  worktreePath: null,
  associatedWorktreePath: null,
  associatedWorktreeBranch: null,
  associatedWorktreeRef: null,
  preferredLocalBranch: null,
  preferredWorktreeBaseBranch: "main",
  preferredNewWorktreeName: "feature/recovery",
};

const result = {
  targetMode: "worktree" as const,
  branch: "feature/recovery",
  worktreePath: "/worktrees/recovery",
  associatedWorktreePath: "/worktrees/recovery",
  associatedWorktreeBranch: "feature/recovery",
  associatedWorktreeRef: "abc123",
  changesTransferred: true,
  conflictsDetected: false,
  message: "Recovered",
};

layer("Git handoff operation recovery", (it) => {
  it.effect(
    "replays durable Git results without running Git again and fences incomplete work",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`DELETE FROM git_handoff_operations`;

        assert.deepStrictEqual(yield* beginGitHandoff(input), { phase: "new" });
        yield* recordGitHandoffResult(input.commandId, result);
        assert.deepStrictEqual(yield* beginGitHandoff(input), {
          phase: "git_applied",
          result,
        });

        const dispatched: unknown[] = [];
        yield* recoverGitHandoffOperations((command) =>
          Effect.sync(() => {
            dispatched.push(command);
          }),
        );
        assert.lengthOf(dispatched, 1);
        assert.deepInclude(dispatched[0] as object, {
          type: "thread.meta.update",
          commandId: input.commandId,
          threadId: input.threadId,
          worktreePath: result.worktreePath,
        });
        assert.deepStrictEqual(yield* beginGitHandoff(input), { phase: "completed", result });

        const interruptedInput = {
          ...input,
          commandId: CommandId.makeUnsafe("git-handoff-interrupted-command"),
        };
        assert.deepStrictEqual(yield* beginGitHandoff(interruptedInput), { phase: "new" });
        yield* recoverGitHandoffOperations(() => Effect.void);
        assert.deepStrictEqual(yield* beginGitHandoff(interruptedInput), { phase: "uncertain" });
      }),
  );
});

layer("Git handoff recovery with unrecoverable rows", (it) => {
  it.effect("fences invalid rows, keeps failed dispatches for retry, and recovers the rest", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM git_handoff_operations`;
      const now = new Date().toISOString();
      const insertApplied = (commandId: string, inputJson: string, resultJson: string) =>
        sql`
          INSERT INTO git_handoff_operations (
            command_id, thread_id, input_json, phase, result_json, created_at, updated_at
          ) VALUES (
            ${commandId}, ${input.threadId}, ${inputJson}, 'git_applied', ${resultJson}, ${now}, ${now}
          )
        `;
      const validInput = (commandId: string) => JSON.stringify({ ...input, commandId });
      const validResult = JSON.stringify(result);

      yield* insertApplied("bad-input", "{not json", validResult);
      yield* insertApplied("bad-result", validInput("bad-result"), JSON.stringify({ nope: 1 }));
      yield* insertApplied("dispatch-fails", validInput("dispatch-fails"), validResult);
      yield* insertApplied("good", validInput("good"), validResult);

      const dispatched: string[] = [];
      const recovered = yield* recoverGitHandoffOperations((command) =>
        command.commandId === "dispatch-fails"
          ? Effect.fail(new Error("orchestration unavailable"))
          : Effect.sync(() => {
              dispatched.push(command.commandId);
            }),
      ).pipe(Effect.exit);
      assert.equal(recovered._tag, "Success");

      assert.deepStrictEqual(dispatched, ["good"]);
      const rows = yield* sql<{
        readonly commandId: string;
        readonly phase: string;
        readonly inputJson: string;
        readonly resultJson: string | null;
      }>`
        SELECT command_id AS "commandId", phase, input_json AS "inputJson", result_json AS "resultJson"
        FROM git_handoff_operations
        ORDER BY command_id ASC
      `;
      assert.deepStrictEqual(rows, [
        {
          commandId: "bad-input",
          phase: "uncertain",
          inputJson: "{not json",
          resultJson: validResult,
        },
        {
          commandId: "bad-result",
          phase: "uncertain",
          inputJson: validInput("bad-result"),
          resultJson: JSON.stringify({ nope: 1 }),
        },
        {
          commandId: "dispatch-fails",
          phase: "git_applied",
          inputJson: validInput("dispatch-fails"),
          resultJson: validResult,
        },
        {
          commandId: "good",
          phase: "completed",
          inputJson: validInput("good"),
          resultJson: validResult,
        },
      ]);
    }),
  );
});
