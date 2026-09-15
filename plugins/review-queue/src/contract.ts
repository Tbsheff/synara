import { array, nonEmptyString, object, optional, schema, string } from "@synara/plugin-sdk";

export interface ReviewQueueItem {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly prompt: string;
  readonly status: "queued" | "started";
  readonly createdAt: string;
  readonly threadId?: string;
}

const status = schema<ReviewQueueItem["status"]>((input, path = "value") => {
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
