import { array, nonEmptyString, object, optional, schema, string } from "@synara/plugin-sdk";

const envMode = schema<"local" | "worktree">((input, path = "value") => {
  if (input !== "local" && input !== "worktree") {
    throw new Error(`${path} must be local or worktree.`);
  }
  return input;
});

const status = schema<"idle" | "running" | "interrupted" | "completed" | "error">(
  (input, path = "value") => {
    if (
      input !== "idle" &&
      input !== "running" &&
      input !== "interrupted" &&
      input !== "completed" &&
      input !== "error"
    ) {
      throw new Error(`${path} must be a thread status.`);
    }
    return input;
  },
);

export const puckThread = object({
  threadId: string(),
  title: string(),
  envMode,
  status,
  createdAt: string(),
});
export type PuckThread = Readonly<ReturnType<typeof puckThread.parse>>;

export const puckContract = {
  listThreads: {
    input: object({ projectId: nonEmptyString() }),
    output: object({ threads: array(puckThread) }),
  },
  listOrbs: {
    input: object({ projectId: nonEmptyString() }),
    output: object({ threads: array(puckThread) }),
  },
  startOrb: {
    input: object({
      projectId: nonEmptyString(),
      title: nonEmptyString(),
      prompt: nonEmptyString({ maxLength: 120_000 }),
      parentThreadId: optional(nonEmptyString()),
    }),
    output: object({ thread: puckThread }),
  },
} as const;
