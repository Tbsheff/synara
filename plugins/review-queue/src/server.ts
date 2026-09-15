import { definePlugin, type JsonValue } from "@synara/plugin-sdk";

import { reviewQueueContract, reviewQueueItem, type ReviewQueueItem } from "./contract";

const STORAGE_KEY = "items";

function parseItems(value: JsonValue | undefined): ReviewQueueItem[] {
  if (!Array.isArray(value)) return [];
  return value.map((item, index) => reviewQueueItem.parse(item, `items[${index}]`));
}

function makeItemId(): string {
  return `review-${crypto.randomUUID()}`;
}

export default definePlugin((synara) => {
  const readItems = async () => parseItems(await synara.storage.get(STORAGE_KEY));
  const updateItems = async (
    update: (items: ReviewQueueItem[]) => ReviewQueueItem[] | Promise<ReviewQueueItem[]>,
  ) => parseItems(await synara.storage.update(STORAGE_KEY, (value) => update(parseItems(value))));

  synara.rpc.register("list", reviewQueueContract.list, async () => ({ items: await readItems() }));

  synara.rpc.register("add", reviewQueueContract.add, async (input) => {
    const item: ReviewQueueItem = {
      id: makeItemId(),
      projectId: input.projectId,
      title: input.title,
      prompt: input.prompt,
      status: "queued",
      createdAt: new Date().toISOString(),
    };
    await updateItems((items) => [...items, item]);
    return { item };
  });

  synara.rpc.register("start", reviewQueueContract.start, async ({ itemId }, call) => {
    const items = await updateItems(async (items) => {
      const index = items.findIndex((item) => item.id === itemId);
      if (index < 0) throw new Error(`Review queue item not found: ${itemId}`);
      const current = items[index]!;
      if (current.threadId) return items;
      const { threadId } = await call.host.threads.start({
        projectId: current.projectId,
        title: current.title,
        prompt: current.prompt,
        idempotencyKey: current.id,
        createdAt: current.createdAt,
      });
      return items.with(index, { ...current, status: "started", threadId });
    });
    return { item: items.find((item) => item.id === itemId)! };
  });

  synara.rpc.register("remove", reviewQueueContract.remove, async ({ itemId }) => {
    await updateItems((items) => items.filter((item) => item.id !== itemId));
    return { removed: itemId };
  });
});
