import { definePlugin, type PluginCall } from "@synara/plugin-sdk";

import { puckContract, type PuckThread } from "./contract";

function asPuckThreads(
  threads: ReadonlyArray<{
    readonly threadId: string;
    readonly title: string;
    readonly envMode: "local" | "worktree";
    readonly status: PuckThread["status"];
    readonly createdAt: string;
  }>,
): PuckThread[] {
  return threads.map((thread) => ({
    threadId: thread.threadId,
    title: thread.title,
    envMode: thread.envMode,
    status: thread.status,
    createdAt: thread.createdAt,
  }));
}

export default definePlugin((synara) => {
  const listThreads = async (
    { projectId }: ReturnType<typeof puckContract.listThreads.input.parse>,
    call: PluginCall,
  ) => {
    const result = await call.host.threads.list({ projectId });
    return { threads: asPuckThreads(result.threads) };
  };
  synara.rpc.register("list-threads", puckContract.listThreads, listThreads);
  synara.agents.registerTool({
    id: "list-threads",
    title: "List threads",
    description: "List threads in a Synara project, including isolated Orb worktrees.",
    access: "read",
    contract: puckContract.listThreads,
    execute: listThreads,
  });

  const listOrbs = async (
    { projectId }: ReturnType<typeof puckContract.listOrbs.input.parse>,
    call: PluginCall,
  ) => {
    const result = await call.host.threads.list({ projectId });
    return {
      threads: asPuckThreads(result.threads.filter((thread) => thread.envMode === "worktree")),
    };
  };
  synara.rpc.register("list-orbs", puckContract.listOrbs, listOrbs);
  synara.agents.registerTool({
    id: "list-orbs",
    title: "List orbs",
    description: "List isolated Orb worktree threads in a Synara project.",
    access: "read",
    contract: puckContract.listOrbs,
    execute: listOrbs,
  });

  const startOrb = async (
    input: ReturnType<typeof puckContract.startOrb.input.parse>,
    call: PluginCall,
  ) => {
    const createdAt = new Date().toISOString();
    const { threadId } = await call.host.threads.start({
      projectId: input.projectId,
      title: input.title,
      prompt: input.prompt,
      idempotencyKey: crypto.randomUUID(),
      createdAt,
      environment: "worktree",
      ...(input.parentThreadId ? { parentThreadId: input.parentThreadId } : {}),
    });
    const thread: PuckThread = {
      threadId,
      title: input.title,
      envMode: "worktree",
      status: "running",
      createdAt,
    };
    return { thread };
  };
  synara.rpc.register("start-orb", puckContract.startOrb, startOrb);
  synara.agents.registerTool({
    id: "start-orb",
    title: "Start orb",
    description:
      "Start an isolated Orb: a Synara worktree thread with its own branch and working copy.",
    access: "write",
    contract: puckContract.startOrb,
    execute: startOrb,
  });
});
