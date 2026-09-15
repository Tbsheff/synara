import {
  definePluginApp,
  usePluginRpc,
  usePluginRuntime,
  type PluginNavPanelProps,
} from "@synara/plugin-sdk/app";
import { useCallback, useEffect, useState } from "react";

import { reviewQueueContract, type ReviewQueueItem } from "./contract";

function ReviewQueuePanel({ context, plugin }: PluginNavPanelProps) {
  const call = usePluginRpc(plugin);
  const runtime = usePluginRuntime();
  const [items, setItems] = useState<ReviewQueueItem[]>([]);
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const result = await call("list", reviewQueueContract.list, {});
    setItems(result.items);
    setError(null);
  }, [call]);

  useEffect(() => {
    void load().catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : "Could not load the review queue.");
    });
  }, [load]);

  const run = async (operation: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await operation();
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The plugin call failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="chat-content-card flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      <header className="flex items-center justify-between gap-4 border-b px-6 py-4">
        <div>
          <h1 className="text-base font-semibold">Review Queue</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Queue focused reviews, then start each one as a normal Synara thread.
          </p>
        </div>
        <button
          type="button"
          disabled={busy || !context.projectId || !plugin.editable}
          className="rounded-md border px-3 py-2 text-sm font-medium disabled:opacity-50"
          onClick={() => {
            if (!context.projectId) return;
            setBusy(true);
            setError(null);
            void runtime
              .editPlugin({ plugin, projectId: context.projectId })
              .then(({ threadId }) => runtime.navigate(`/${threadId}`))
              .catch((cause: unknown) => {
                setError(cause instanceof Error ? cause.message : "Could not open an edit chat.");
              })
              .finally(() => setBusy(false));
          }}
        >
          {plugin.editable ? "Edit in chat" : "Source not installed"}
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        <form
          className="mx-auto grid max-w-3xl gap-3 rounded-xl border bg-card p-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!context.projectId || !title.trim() || !prompt.trim()) return;
            void run(async () => {
              await call("add", reviewQueueContract.add, {
                projectId: context.projectId!,
                title: title.trim(),
                prompt: prompt.trim(),
              });
              setTitle("");
              setPrompt("");
            });
          }}
        >
          <label className="grid gap-1 text-sm font-medium">
            Title
            <input
              className="rounded-md border bg-background px-3 py-2 font-normal outline-none focus:ring-2 focus:ring-ring"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Review the current branch"
            />
          </label>
          <label className="grid gap-1 text-sm font-medium">
            Prompt
            <textarea
              className="min-h-24 resize-y rounded-md border bg-background px-3 py-2 font-normal outline-none focus:ring-2 focus:ring-ring"
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder="Review the current branch for correctness and test gaps."
            />
          </label>
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs text-muted-foreground">
              {context.projectId ? "Uses the latest active project." : "Open a project first."}
            </span>
            <button
              type="submit"
              disabled={busy || !context.projectId || !title.trim() || !prompt.trim()}
              className="rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
            >
              Add review
            </button>
          </div>
        </form>

        {error ? <p className="mx-auto mt-4 max-w-3xl text-sm text-destructive">{error}</p> : null}

        <section className="mx-auto mt-6 grid max-w-3xl gap-2" aria-label="Queued reviews">
          {items.length === 0 ? (
            <div className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
              No reviews are queued.
            </div>
          ) : (
            items.map((item) => (
              <article key={item.id} className="flex items-start gap-4 rounded-xl border bg-card p-4">
                <div className="min-w-0 flex-1">
                  <h2 className="truncate text-sm font-medium">{item.title}</h2>
                  <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{item.prompt}</p>
                  <p className="mt-2 text-xs capitalize text-muted-foreground">{item.status}</p>
                </div>
                <div className="flex gap-2">
                  {item.threadId ? (
                    <button
                      type="button"
                      className="rounded-md border px-3 py-1.5 text-xs font-medium"
                      onClick={() => runtime.navigate(`/${item.threadId}`)}
                    >
                      Open
                    </button>
                  ) : (
                    <button
                      type="button"
                      disabled={busy}
                      className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
                      onClick={() => void run(async () => void (await call("start", reviewQueueContract.start, { itemId: item.id })))}
                    >
                      Start
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={busy}
                    className="rounded-md border px-3 py-1.5 text-xs text-muted-foreground disabled:opacity-50"
                    onClick={() => void run(async () => void (await call("remove", reviewQueueContract.remove, { itemId: item.id })))}
                  >
                    Remove
                  </button>
                </div>
              </article>
            ))
          )}
        </section>
      </div>
    </main>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "queue",
    title: "Review Queue",
    component: ReviewQueuePanel,
  });
});
