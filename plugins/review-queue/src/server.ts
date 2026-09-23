import { definePlugin, type JsonValue, type PluginCall } from "@synara/plugin-sdk";

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

  const listReviews = async () => ({ items: await readItems() });
  synara.rpc.register("list", reviewQueueContract.list, listReviews);
  synara.agents.registerTool({
    id: "list-reviews",
    title: "List reviews",
    description: "List items in the Synara review queue.",
    access: "read",
    contract: reviewQueueContract.list,
    execute: listReviews,
  });

  const addReview = async (input: ReturnType<typeof reviewQueueContract.add.input.parse>) => {
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
  };

  synara.rpc.register("add", reviewQueueContract.add, addReview);
  synara.agents.registerTool({
    id: "add-review",
    title: "Add review",
    description: "Add an item to the Synara review queue.",
    access: "write",
    contract: reviewQueueContract.add,
    execute: addReview,
  });

  const startReview = async (
    { itemId }: ReturnType<typeof reviewQueueContract.start.input.parse>,
    call: PluginCall,
  ) => {
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
  };
  synara.rpc.register("start", reviewQueueContract.start, startReview);
  synara.agents.registerTool({
    id: "start-review",
    title: "Start review",
    description: "Start a queued review as a normal Synara thread.",
    access: "write",
    contract: reviewQueueContract.start,
    execute: startReview,
  });

  const removeReview = async ({
    itemId,
  }: ReturnType<typeof reviewQueueContract.remove.input.parse>) => {
    await updateItems((items) => items.filter((item) => item.id !== itemId));
    return { removed: itemId };
  };
  synara.rpc.register("remove", reviewQueueContract.remove, removeReview);
  synara.agents.registerTool({
    id: "remove-review",
    title: "Remove review",
    description: "Remove an item from the Synara review queue.",
    access: "write",
    contract: reviewQueueContract.remove,
    execute: removeReview,
  });
});
