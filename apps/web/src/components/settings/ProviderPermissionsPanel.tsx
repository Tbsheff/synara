import type { ProviderGetPermissionsInput, ProviderPermissionsResult } from "@synara/contracts";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import { resolveAndPersistPreferredEditor } from "~/editorPreferences";
import { serverConfigQueryOptions, serverQueryKeys } from "~/lib/serverReactQuery";
import { ensureNativeApi } from "~/nativeApi";
import { SettingsListRow } from "./SettingsPanelPrimitives";

export function ProviderPermissionRows({ result }: { result: ProviderPermissionsResult }) {
  if (!result.supported)
    return (
      <p className="text-ui-sm text-muted-foreground">
        This provider does not report its loaded policy. Use its configuration to check file and
        network limits.
      </p>
    );
  return (
    <>
      {result.rows.map((row) => (
        <SettingsListRow
          key={row.key}
          title={row.label}
          description={`Source: ${row.source}${row.managed ? " · Managed, read-only" : " · Read-only here"}`}
          actions={<span className="text-ui-sm">{row.value}</span>}
        />
      ))}
      {!result.requirementsRead ? (
        <p role="status" className="text-ui-sm text-muted-foreground">
          Administrator requirements could not be read. More limits can apply.
        </p>
      ) : null}
    </>
  );
}

export function ProviderPermissionsPanel({
  input,
  beforeLoad,
}: {
  input: ProviderGetPermissionsInput;
  beforeLoad: () => Promise<void>;
}) {
  const config = useQuery(serverConfigQueryOptions());
  const permissions = useQuery({
    queryKey: [
      ...serverQueryKeys.all,
      "providerPermissions",
      input.provider,
      input.instanceId,
      input.cwd,
    ],
    queryFn: async () => {
      await beforeLoad();
      return ensureNativeApi().provider.getPermissions(input);
    },
    enabled: false,
    retry: false,
  });
  const [openError, setOpenError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const openConfig = async () => {
    const path = permissions.data?.configPath;
    if (!path || opening) return;
    setOpenError(null);
    const editor = resolveAndPersistPreferredEditor(config.data?.availableEditors ?? []);
    if (!editor) {
      setOpenError("No available editors found.");
      return;
    }
    setOpening(true);
    try {
      await ensureNativeApi().shell.openInEditor(path, editor);
    } catch {
      setOpenError("Could not open the provider configuration.");
    } finally {
      setOpening(false);
    }
  };
  return (
    <div className="space-y-2">
      <p className="text-ui-sm text-muted-foreground">
        Load the account's provider defaults and managed limits. Conversation settings can override
        defaults. Refresh after a config change.
      </p>
      <div className="flex gap-2">
        <Button
          size="xs"
          variant="outline"
          disabled={permissions.isFetching}
          onClick={() => void permissions.refetch()}
        >
          {permissions.isFetching
            ? "Loading permissions…"
            : permissions.data
              ? "Refresh permissions"
              : "Load permissions"}
        </Button>
        {permissions.data?.configPath ? (
          <Button size="xs" variant="outline" disabled={opening} onClick={() => void openConfig()}>
            Open provider config
          </Button>
        ) : null}
      </div>
      {permissions.isError ? (
        <p role="alert" className="text-ui-sm text-destructive">
          Could not load provider permissions. Try again.
        </p>
      ) : null}
      {permissions.data ? <ProviderPermissionRows result={permissions.data} /> : null}
      {openError ? (
        <p role="alert" className="text-ui-sm text-destructive">
          {openError}
        </p>
      ) : null}
    </div>
  );
}
