import type { CommandParsedAction } from "@synara/contracts";

export interface PermissionProfileLine {
  label: string;
  values: ReadonlyArray<string>;
  rawJson?: string;
}

export const MORE_PERMISSIONS_LABEL = "More permissions";
const MAX_PERMISSION_PROFILE_DEPTH = 3;
const MAX_RAW_PERMISSION_JSON_CHARS = 2_000;

type PermissionPath = ReadonlyArray<string>;

interface DroppedPermissionPart {
  path: PermissionPath;
  value: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isStructured(value: unknown): boolean {
  return value !== null && typeof value === "object";
}

function stringList(
  value: unknown,
  path: PermissionPath,
  dropped: DroppedPermissionPart[],
): string[] {
  if (!Array.isArray(value)) return [];
  const nonStrings = value.filter(
    (entry) => typeof entry !== "string" && entry !== null && entry !== undefined,
  );
  if (nonStrings.length > 0) dropped.push({ path, value: nonStrings });
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export function humanizePermissionKey(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .replace(/[_-]+/gu, " ")
    .trim()
    .toLowerCase();
  return words.length > 0 ? `${words.charAt(0).toUpperCase()}${words.slice(1)}` : key;
}

function scalarText(value: unknown): string | null {
  if (typeof value === "string") return value.trim().length > 0 ? value.trim() : null;
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return null;
}

function genericPermissionLines(
  label: string,
  value: unknown,
  depth: number,
  path: PermissionPath,
  dropped: DroppedPermissionPart[],
): PermissionProfileLine[] {
  const scalar = scalarText(value);
  if (scalar !== null) return [{ label, values: [scalar] }];
  if (Array.isArray(value)) {
    const structuredEntries = value.filter(isStructured);
    if (structuredEntries.length > 0) dropped.push({ path, value: structuredEntries });
    const values = value.map(scalarText).filter((entry): entry is string => entry !== null);
    return values.length > 0 ? [{ label, values }] : [];
  }
  const record = asRecord(value);
  if (!record) return [];
  if (depth >= MAX_PERMISSION_PROFILE_DEPTH) {
    if (Object.keys(record).length > 0) dropped.push({ path, value: record });
    return [];
  }
  return Object.entries(record).flatMap(([key, nested]) =>
    genericPermissionLines(
      `${label} · ${humanizePermissionKey(key).toLowerCase()}`,
      nested,
      depth + 1,
      [...path, key],
      dropped,
    ),
  );
}

function networkPermissionLines(
  key: string,
  value: unknown,
  dropped: DroppedPermissionPart[],
): PermissionProfileLine[] {
  const network = asRecord(value);
  if (network === null) return genericPermissionLines("Network", value, 0, [key], dropped);
  const lines: PermissionProfileLine[] = [];
  if (network.enabled === true) lines.push({ label: "Internet access", values: [] });
  for (const [nestedKey, nested] of Object.entries(network)) {
    if (nestedKey === "enabled") continue;
    lines.push(
      ...genericPermissionLines(
        `Network · ${humanizePermissionKey(nestedKey).toLowerCase()}`,
        nested,
        1,
        [key, nestedKey],
        dropped,
      ),
    );
  }
  return lines;
}

function fileSystemPermissionLines(
  key: string,
  value: unknown,
  dropped: DroppedPermissionPart[],
): PermissionProfileLine[] {
  const fileSystem = asRecord(value);
  if (fileSystem === null) return genericPermissionLines("Files", value, 0, [key], dropped);
  const lines: PermissionProfileLine[] = [];
  const read = stringList(fileSystem.read, [key, "read"], dropped);
  const write = stringList(fileSystem.write, [key, "write"], dropped);
  if (read.length > 0) lines.push({ label: "View files", values: read });
  if (write.length > 0) lines.push({ label: "Edit files", values: write });
  for (const [nestedKey, nested] of Object.entries(fileSystem)) {
    if (nestedKey === "read" || nestedKey === "write") continue;
    lines.push(
      ...genericPermissionLines(
        `Files · ${humanizePermissionKey(nestedKey).toLowerCase()}`,
        nested,
        1,
        [key, nestedKey],
        dropped,
      ),
    );
  }
  return lines;
}

function nestDroppedParts(dropped: ReadonlyArray<DroppedPermissionPart>): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  for (const { path, value } of dropped) {
    let cursor = root;
    for (const segment of path.slice(0, -1)) {
      const next = asRecord(cursor[segment]) ?? {};
      cursor[segment] = next;
      cursor = next;
    }
    const leaf = path.at(-1);
    if (leaf !== undefined) cursor[leaf] = value;
  }
  return root;
}

function rawPermissionJson(value: unknown): string {
  const json = JSON.stringify(
    value,
    (_key, nested: unknown) => (typeof nested === "bigint" ? nested.toString() : nested),
    2,
  );
  return json.length > MAX_RAW_PERMISSION_JSON_CHARS
    ? `${json.slice(0, MAX_RAW_PERMISSION_JSON_CHARS - 1)}…`
    : json;
}

export function formatPermissionProfileLines(
  profile: Record<string, unknown>,
): PermissionProfileLine[] {
  const dropped: DroppedPermissionPart[] = [];
  const lines = Object.entries(profile).flatMap(([key, value]) => {
    if (key === "network") return networkPermissionLines(key, value, dropped);
    if (key === "fileSystem" || key === "file_system") {
      return fileSystemPermissionLines(key, value, dropped);
    }
    return genericPermissionLines(humanizePermissionKey(key), value, 0, [key], dropped);
  });
  if (dropped.length === 0) return lines;
  return [
    ...lines,
    {
      label: MORE_PERMISSIONS_LABEL,
      values: [],
      rawJson: rawPermissionJson(nestDroppedParts(dropped)),
    },
  ];
}

export function formatParsedActionLabel(action: CommandParsedAction): string {
  const target = action.name ?? action.path;
  switch (action.type) {
    case "read":
      return target ? `Read ${target}` : "Read a file";
    case "search": {
      const query = action.query ? `Search for ${action.query}` : "Search files";
      return action.path ? `${query} in ${action.path}` : query;
    }
    case "list_files":
      return action.path ? `List files in ${action.path}` : "List files";
    case "unknown":
      return action.command ?? "Run a command";
  }
}
