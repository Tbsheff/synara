import type {
  OrchestrationEvent,
  ProviderKind,
  ProviderMcpAuthState,
  ThreadId,
} from "@synara/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { ensureNativeApi } from "~/nativeApi";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";

interface ComposerMcpAuthProps {
  threadId: ThreadId;
  provider: ProviderKind;
  enabled: boolean;
}

export function ComposerMcpAuth({ threadId, provider, enabled }: ComposerMcpAuthProps) {
  const client = useQueryClient();
  const queryKey = useMemo(
    () => ["provider", "mcp-auth", threadId, provider] as const,
    [threadId, provider],
  );
  const active = enabled && (provider === "codex" || provider === "claudeAgent");
  const query = useQuery({
    queryKey,
    queryFn: () => ensureNativeApi().provider.getMcpAuth({ threadId }),
    enabled: active,
    refetchInterval: (query) =>
      query.state.data?.servers.some((server) => server.status === "authenticating")
        ? 10_000
        : 300_000,
    retry: false,
  });
  useEffect(() => {
    if (!active) return;
    const refresh = () => void client.invalidateQueries({ queryKey });
    const onEvent = (event: OrchestrationEvent) => {
      if (
        event.aggregateId !== threadId &&
        !("threadId" in event.payload && event.payload.threadId === threadId)
      )
        return;
      if (event.type === "thread.session-set") refresh();
      else if (
        event.type === "thread.activity-appended" &&
        event.payload.activity.kind === "transcript.notice"
      ) {
        const payload = event.payload.activity.payload;
        if (
          payload &&
          typeof payload === "object" &&
          "noticeKind" in payload &&
          (payload.noticeKind === "mcp-server-status" || payload.noticeKind === "mcp-oauth")
        )
          refresh();
      }
    };
    return ensureNativeApi().orchestration.onThreadEvent((item) => {
      if (item.kind === "snapshot") {
        if (item.snapshot.thread.id === threadId) refresh();
      } else if (item.kind === "event") onEvent(item.event);
      else if (item.kind === "replay") item.events.forEach(onEvent);
    });
  }, [active, client, queryKey, threadId]);
  if (!enabled || !query.data?.sessionKey || query.data.servers.length === 0) return null;
  return (
    <McpAuthList
      key={query.data.sessionKey}
      threadId={threadId}
      state={query.data}
      readError={query.error?.message}
      onUpdate={(state) => {
        if (client.getQueryData<ProviderMcpAuthState>(queryKey)?.sessionKey !== state.sessionKey)
          return false;
        client.setQueryData(queryKey, state);
        return true;
      }}
      onRefresh={async () => {
        await client.cancelQueries({ queryKey });
        const state = await ensureNativeApi().provider.getMcpAuth({ threadId, refresh: true });
        client.setQueryData<ProviderMcpAuthState>(queryKey, (previous) =>
          previous?.sessionKey === query.data?.sessionKey ? state : previous,
        );
      }}
    />
  );
}

function McpAuthList({
  threadId,
  state,
  readError,
  onUpdate,
  onRefresh,
}: {
  threadId: ThreadId;
  state: ProviderMcpAuthState;
  readError?: string | undefined;
  onUpdate: (state: ProviderMcpAuthState) => boolean;
  onRefresh: () => Promise<void>;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const busyRef = useRef(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [copiedServer, setCopiedServer] = useState<string | null>(null);
  const { copyToClipboard, isCopied } = useCopyToClipboard<string>({
    onCopy: setCopiedServer,
    onError: (error, name) => setErrors((current) => ({ ...current, [name]: error.message })),
  });
  const [authorizationUrls, setAuthorizationUrls] = useState<Record<string, string>>({});
  const [refreshError, setRefreshError] = useState<string | undefined>();
  const count = state.servers.length;
  const signIn = async (server: ProviderMcpAuthState["servers"][number]) => {
    if (server.action.type === "manual") return;
    if (busyRef.current || !state.sessionKey) return;
    busyRef.current = true;
    setBusy(server.name);
    setErrors((current) => ({ ...current, [server.name]: "" }));
    try {
      const result = await ensureNativeApi().provider.authenticateMcp({
        threadId,
        sessionKey: state.sessionKey,
        serverName: server.name,
      });
      if (!onUpdate(result.state)) return;
      if (result.authorizationUrl) {
        setAuthorizationUrls((current) => ({
          ...current,
          [server.name]: result.authorizationUrl!,
        }));
        await ensureNativeApi().shell.openExternal(result.authorizationUrl);
      }
    } catch (error) {
      setErrors((current) => ({
        ...current,
        [server.name]: error instanceof Error ? error.message : "MCP sign-in failed.",
      }));
    } finally {
      busyRef.current = false;
      setBusy(null);
    }
  };
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-ui-xs font-normal text-muted-foreground"
          />
        }
      >
        {count} MCP {count === 1 ? "server needs" : "servers need"} sign-in
      </PopoverTrigger>
      <PopoverPopup side="top" align="start" className="w-[min(24rem,92vw)]">
        <div className="space-y-3">
          <PopoverTitle className="text-ui-lg">MCP sign-in</PopoverTitle>
          <ul className="space-y-3">
            {state.servers.map((server) => (
              <li key={server.name} className="space-y-2 text-ui-sm">
                <div className="flex items-center justify-between gap-3">
                  <span className="min-w-0 break-words">{server.name}</span>
                  {server.action.type === "manual" ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      aria-label={`Copy command for ${server.name}`}
                      onClick={() => {
                        if (server.action.type === "manual")
                          copyToClipboard(server.action.command, server.name);
                      }}
                    >
                      {isCopied && copiedServer === server.name ? "Copied" : "Copy"}
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      aria-label={`Authenticate ${server.name}`}
                      disabled={
                        busy !== null ||
                        state.servers.some((entry) => entry.status === "authenticating")
                      }
                      onClick={() => void signIn(server)}
                    >
                      {busy === server.name || server.status === "authenticating"
                        ? "Signing in…"
                        : "Authenticate"}
                    </Button>
                  )}
                </div>
                {(errors[server.name] || server.error) && (
                  <p role="alert" className="break-words text-ui-sm text-destructive">
                    {errors[server.name] || server.error}
                  </p>
                )}
                {server.status === "authenticating" && (
                  <div className="space-y-1 text-ui-xs text-muted-foreground">
                    <p>
                      Complete sign-in in your browser. The callback must reach the Synara server
                      machine.
                    </p>
                    {authorizationUrls[server.name] && (
                      <Button
                        type="button"
                        variant="link"
                        size="sm"
                        className="h-auto p-0 text-ui-xs"
                        onClick={() => {
                          void ensureNativeApi()
                            .shell.openExternal(authorizationUrls[server.name]!)
                            .catch((error: unknown) =>
                              setErrors((current) => ({
                                ...current,
                                [server.name]:
                                  error instanceof Error
                                    ? error.message
                                    : "Could not open sign-in.",
                              })),
                            );
                        }}
                      >
                        Open sign-in
                      </Button>
                    )}
                  </div>
                )}
                {server.action.type === "manual" && (
                  <div className="space-y-2 text-ui-xs text-muted-foreground">
                    <p>{server.action.instructions}</p>
                    <code className="block whitespace-pre-wrap break-all [font-family:inherit] rounded-md bg-muted p-2 text-ui-xs">
                      {server.action.command}
                    </code>
                  </div>
                )}
              </li>
            ))}
          </ul>
          {(refreshError || readError) && (
            <p role="alert" className="text-ui-sm text-destructive">
              {refreshError || readError}
            </p>
          )}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy !== null}
            onClick={async () => {
              setBusy("refresh");
              setRefreshError(undefined);
              try {
                await onRefresh();
              } catch (error) {
                setRefreshError(
                  error instanceof Error ? error.message : "Could not check MCP sign-in.",
                );
              } finally {
                setBusy(null);
              }
            }}
          >
            Re-check
          </Button>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
