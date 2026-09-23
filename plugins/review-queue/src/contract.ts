import { array, nonEmptyString, object, optional, schema, string } from "@synara/plugin-sdk";

const status = schema<"queued" | "started">((input, path = "value") => {
  if (input !== "queued" && input !== "started") {
    throw new Error(`${path} must be queued or started.`);
  }
  return input;
});

export const reviewQueueItem = object({
  id: string(),
  projectId: string(),
  title: string(),
  prompt: string(),
  status,
  createdAt: string(),
  threadId: optional(string()),
});
export type ReviewQueueItem = Readonly<ReturnType<typeof reviewQueueItem.parse>>;

export const reviewQueueContract = {
  list: {
    input: schema(() => ({})),
    output: object({ items: array(reviewQueueItem) }),
  },
  add: {
    input: object({
      projectId: nonEmptyString(),
      title: nonEmptyString(),
      prompt: nonEmptyString({ maxLength: 120_000 }),
    }),
    output: object({ item: reviewQueueItem }),
  },
  start: {
    input: object({ itemId: nonEmptyString() }),
    output: object({ item: reviewQueueItem }),
  },
  remove: {
    input: object({ itemId: nonEmptyString() }),
    output: object({ removed: string() }),
  },
} as const;
