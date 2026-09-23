import {
  definePluginApp,
  usePluginRpc,
  usePluginRuntime,
  type PluginComponentProps,
  type PluginHomepageSectionProps,
  type PluginNavPanelProps,
} from "@synara/plugin-sdk/app";
import { useCallback, useEffect, useMemo, useState } from "react";

import { puckContract, type PuckThread } from "./contract";

const OPEN_PUCK_EVENT = "synara-puck-open";

function PuckIcon({ className }: { readonly className?: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      className={className}
    >
      <circle cx="12" cy="12" r="7.5" />
      <path d="M8 12h8M12 8v8" />
    </svg>
  );
}

function isPuckShortcut(event: KeyboardEvent): boolean {
  if (event.repeat || event.altKey) return false;
  const slash = event.code === "Slash" || event.key === "/" || event.key === "?";
  return slash && event.shiftKey && (event.metaKey || event.ctrlKey);
}

function PuckHomepage({ context, plugin }: PluginHomepageSectionProps) {
  const call = usePluginRpc(plugin);
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    if (!context.projectId) {
      setCount(null);
      return;
    }
    void call("list-orbs", puckContract.listOrbs, { projectId: context.projectId }).then(
      ({ threads }) => setCount(threads.length),
      () => setCount(null),
    );
  }, [call, context.projectId]);
  return (
    <div className="flex items-center gap-3 text-sm">
      <PuckIcon className="size-5 text-primary" />
      <span>
        {count === null
          ? "Puck starts isolated Orbs (worktree threads)."
          : `${count} orb${count === 1 ? "" : "s"} in this project.`}
      </span>
    </div>
  );
}

function PuckSettings() {
  return (
    <p className="text-sm text-muted-foreground">
      Puck opens with ⌘⇧/ or Ctrl+Shift+/. Orbs are Synara worktree threads, not remote machines.
    </p>
  );
}

function ThreadRows({
  threads,
  empty,
  onOpen,
}: {
  readonly threads: readonly PuckThread[];
  readonly empty: string;
  readonly onOpen: (threadId: string) => void;
}) {
  if (threads.length === 0) {
    return (
      <div className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
        {empty}
      </div>
    );
  }
  return (
    <ul className="grid gap-2">
      {threads.map((thread) => (
        <li key={thread.threadId}>
          <button
            type="button"
            className="flex w-full items-start justify-between gap-3 rounded-xl border bg-card p-4 text-left"
            onClick={() => onOpen(thread.threadId)}
          >
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium">{thread.title}</span>
              <span className="mt-1 block text-xs capitalize text-muted-foreground">
                {thread.envMode === "worktree" ? "Orb" : "Local"} · {thread.status}
              </span>
            </span>
            <span className="text-xs font-medium text-muted-foreground">Open</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function OrbsPanel({ context, plugin }: PluginNavPanelProps) {
  const call = usePluginRpc(plugin);
  const runtime = usePluginRuntime();
  const [threads, setThreads] = useState<PuckThread[]>([]);
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!context.projectId) {
      setThreads([]);
      return;
    }
    const result = await call("list-orbs", puckContract.listOrbs, { projectId: context.projectId });
    setThreads(result.threads);
    setError(null);
  }, [call, context.projectId]);

  useEffect(() => {
    void load().catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : "Could not load Orbs.");
    });
  }, [load]);

  return (
    <main className="chat-content-card flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      <header className="border-b px-6 py-4">
        <h1 className="text-base font-semibold">Orbs</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Isolated worktree threads. Each Orb has its own branch and working copy.
        </p>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        <form
          className="mx-auto grid max-w-3xl gap-3 rounded-xl border bg-card p-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!context.projectId || !title.trim() || !prompt.trim()) return;
            setBusy(true);
            setError(null);
            void call("start-orb", puckContract.startOrb, {
              projectId: context.projectId,
              title: title.trim(),
              prompt: prompt.trim(),
              ...(context.threadId ? { parentThreadId: context.threadId } : {}),
            })
              .then(({ thread }) => {
                setTitle("");
                setPrompt("");
                runtime.navigate(`/${thread.threadId}`);
              })
              .catch((cause: unknown) => {
                setError(cause instanceof Error ? cause.message : "Could not start an Orb.");
              })
              .finally(() => setBusy(false));
          }}
        >
          <label className="grid gap-1 text-sm font-medium">
            Title
            <input
              className="rounded-md border bg-background px-3 py-2 font-normal outline-none focus:ring-2 focus:ring-ring"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Investigate flaky tests"
            />
          </label>
          <label className="grid gap-1 text-sm font-medium">
            Prompt
            <textarea
              className="min-h-24 resize-y rounded-md border bg-background px-3 py-2 font-normal outline-none focus:ring-2 focus:ring-ring"
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder="Investigate the flaky tests in an isolated worktree."
            />
          </label>
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs text-muted-foreground">
              {context.projectId ? "Starts a worktree thread." : "Open a project first."}
            </span>
            <button
              type="submit"
              disabled={busy || !context.projectId || !title.trim() || !prompt.trim()}
              className="rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
            >
              Start Orb
            </button>
          </div>
        </form>
        {error ? <p className="mx-auto mt-4 max-w-3xl text-sm text-destructive">{error}</p> : null}
        <section className="mx-auto mt-6 max-w-3xl" aria-label="Orbs">
          <ThreadRows
            threads={threads}
            empty="No Orbs yet. Start one to work in an isolated worktree."
            onOpen={(threadId) => runtime.navigate(`/${threadId}`)}
          />
        </section>
      </div>
    </main>
  );
}

function PuckOverlay({ context, plugin }: PluginComponentProps) {
  const call = usePluginRpc(plugin);
  const runtime = usePluginRuntime();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [prompt, setPrompt] = useState("");
  const [threads, setThreads] = useState<PuckThread[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!context.projectId) {
      setThreads([]);
      return;
    }
    const result = await call("list-threads", puckContract.listThreads, {
      projectId: context.projectId,
    });
    setThreads(result.threads);
    setError(null);
  }, [call, context.projectId]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && open) {
        event.preventDefault();
        setOpen(false);
        return;
      }
      if (!isPuckShortcut(event)) return;
      event.preventDefault();
      setOpen((current) => !current);
    };
    const onOpen = () => setOpen(true);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener(OPEN_PUCK_EVENT, onOpen);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener(OPEN_PUCK_EVENT, onOpen);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    void load().catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : "Could not load threads.");
    });
  }, [load, open]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return threads;
    return threads.filter(
      (thread) =>
        thread.title.toLowerCase().includes(needle) ||
        thread.threadId.toLowerCase().includes(needle),
    );
  }, [query, threads]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-6 pt-[12vh]"
      role="presentation"
      onClick={() => setOpen(false)}
    >
      <div
        role="dialog"
        aria-label="Puck"
        className="flex max-h-[72vh] w-full max-w-xl flex-col overflow-hidden rounded-xl border bg-background shadow-lg"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="border-b px-4 py-3">
          <div className="flex items-center gap-2">
            <PuckIcon className="size-4 text-primary" />
            <h1 className="text-sm font-semibold">Puck</h1>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Find threads and start Orbs. Esc closes. ⌘⇧/ toggles.
          </p>
        </header>
        <div className="grid gap-3 overflow-y-auto p-4">
          <input
            autoFocus
            className="rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search threads"
          />
          <form
            className="grid gap-2 rounded-xl border bg-card p-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (!context.projectId || !prompt.trim()) return;
              const text = prompt.trim();
              const title = text.split("\n")[0]?.slice(0, 72) || "Orb";
              setBusy(true);
              setError(null);
              void call("start-orb", puckContract.startOrb, {
                projectId: context.projectId,
                title,
                prompt: text,
                ...(context.threadId ? { parentThreadId: context.threadId } : {}),
              })
                .then(({ thread }) => {
                  setPrompt("");
                  setOpen(false);
                  runtime.navigate(`/${thread.threadId}`);
                })
                .catch((cause: unknown) => {
                  setError(cause instanceof Error ? cause.message : "Could not start an Orb.");
                })
                .finally(() => setBusy(false));
            }}
          >
            <textarea
              className="min-h-20 resize-y rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder="Start an Orb with this prompt"
            />
            <div className="flex justify-end">
              <button
                type="submit"
                disabled={busy || !context.projectId || !prompt.trim()}
                className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
              >
                Start Orb
              </button>
            </div>
          </form>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          <ThreadRows
            threads={filtered}
            empty={context.projectId ? "No matching threads." : "Open a project first."}
            onOpen={(threadId) => {
              setOpen(false);
              runtime.navigate(`/${threadId}`);
            }}
          />
        </div>
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.experimental_icons.register({ name: "puck", component: PuckIcon });
  app.slots.homepageSection({
    id: "puck-summary",
    title: "Puck",
    component: PuckHomepage,
  });
  app.slots.settingsSection({
    id: "puck-settings",
    title: "Puck",
    description: "Coordinator overlay and isolated Orbs",
    component: PuckSettings,
  });
  app.slots.navPanel({
    id: "orbs",
    title: "Orbs",
    icon: "puck",
    component: OrbsPanel,
  });
  app.slots.experimental_appOverlay({
    id: "puck-overlay",
    component: PuckOverlay,
  });
  app.commands.register({
    id: "open-puck",
    title: "Open Puck",
    run: () => {
      window.dispatchEvent(new Event(OPEN_PUCK_EVENT));
    },
  });
});
