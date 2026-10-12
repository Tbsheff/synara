// FILE: Diffs.ts
// Purpose: Parses unified diffs into checkpoint file summaries.
// Layer: Server checkpointing helper

import type { OrchestrationCheckpointFile } from "@synara/contracts";
import { Effect } from "effect";

type UnifiedDiffFileType = "change" | "new" | "deleted" | "rename-pure" | "rename-changed";

interface UnifiedDiffFileSummary {
  readonly name: string;
  readonly type: UnifiedDiffFileType;
  readonly additions: number;
  readonly deletions: number;
}

interface HunkHeader {
  readonly deletionCount: number;
  readonly additionCount: number;
}

const COMMIT_METADATA_SPLIT = /(?=^From [a-f0-9]+ .+$)/m;
const GIT_DIFF_HEADER = /^diff --git (?:"a\/(.+?)"|a\/(.+?)) (?:"b\/(.+?)"|b\/(.+?))$/;
const GIT_FILENAME_HEADER = /^(---|\+\+\+)\s+(?:"[ab]\/(.+)"|[ab]\/([^\t\r\n]+))/;
const UNIFIED_FILENAME_HEADER = /^(---|\+\+\+)\s+([^\t\r\n]+)/;
const HUNK_HEADER = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/;
const C_QUOTE_ESCAPES: Record<string, number> = {
  a: 7,
  b: 8,
  t: 9,
  n: 10,
  v: 11,
  f: 12,
  r: 13,
  '"': 34,
  "\\": 92,
};
const textDecoder = new TextDecoder();

function unquoteGitPath(value: string): string {
  const bytes: number[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]!;
    if (char !== "\\") {
      bytes.push(...new TextEncoder().encode(char));
      continue;
    }
    const octal = /^[0-7]{3}/.exec(value.slice(index + 1));
    if (octal) {
      bytes.push(Number.parseInt(octal[0], 8));
      index += 3;
      continue;
    }
    const escaped = value[index + 1] ?? "";
    bytes.push(C_QUOTE_ESCAPES[escaped] ?? escaped.charCodeAt(0));
    index += 1;
  }
  return textDecoder.decode(new Uint8Array(bytes));
}

function gitHeaderPath(value: string): string {
  const trimmed = value.trim();
  return trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')
    ? unquoteGitPath(trimmed.slice(1, -1))
    : trimmed;
}

function parseHunkHeader(line: string): HunkHeader | null {
  const match = HUNK_HEADER.exec(line);
  if (!match) return null;
  return {
    deletionCount: match[1] === undefined ? 1 : Number.parseInt(match[1], 10),
    additionCount: match[2] === undefined ? 1 : Number.parseInt(match[2], 10),
  };
}

function splitLines(contents: string): string[] {
  const lines = contents.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function splitAtLinePrefix(contents: string, prefix: string): string[] {
  const parts: string[] = [];
  let current: string[] = [];
  for (const line of contents.split("\n")) {
    if (line.startsWith(prefix) && current.length > 0) {
      parts.push(current.join("\n"));
      current = [];
    }
    current.push(line);
  }
  parts.push(current.join("\n"));
  return parts;
}

function isUnifiedHeaderLine(line: string | undefined, prefix: "---" | "+++"): boolean {
  if (line === undefined || !line.startsWith(prefix)) return false;
  const separator = line[prefix.length];
  return (
    (separator === " " || separator === "\t") && line.slice(prefix.length + 1).trim().length > 0
  );
}

function splitUnifiedDiffFiles(contents: string): string[] {
  const lines = contents.split("\n");
  const parts: string[] = [];
  let current: string[] = [];
  let remainingDeletions = 0;
  let remainingAdditions = 0;
  let hasOpenedFile = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (remainingDeletions <= 0 && remainingAdditions <= 0) {
      if (isUnifiedHeaderLine(line, "---") && isUnifiedHeaderLine(lines[index + 1], "+++")) {
        if (current.length > 0) parts.push(current.join("\n"));
        current = [line, lines[index + 1]!];
        hasOpenedFile = true;
        index += 1;
        continue;
      }
      const hunk = hasOpenedFile ? parseHunkHeader(line) : null;
      if (hunk) {
        remainingDeletions = hunk.deletionCount;
        remainingAdditions = hunk.additionCount;
      }
      current.push(line);
      continue;
    }
    const firstChar = line[0];
    if (firstChar === " ") {
      remainingDeletions -= 1;
      remainingAdditions -= 1;
    } else if (firstChar === "-") {
      remainingDeletions -= 1;
    } else if (firstChar === "+") {
      remainingAdditions -= 1;
    }
    current.push(line);
  }
  parts.push(current.join("\n"));
  return parts;
}

function countHunk(lines: ReadonlyArray<string>, header: HunkHeader) {
  let additions = 0;
  let deletions = 0;
  let parsedAdditions = 0;
  let parsedDeletions = 0;
  let end = lines.length;
  while (end > 1 && lines[end - 1]!.length === 0) end -= 1;
  for (let index = 1; index < end; index += 1) {
    const firstChar = lines[index]![0];
    if (
      parsedAdditions >= header.additionCount &&
      parsedDeletions >= header.deletionCount &&
      firstChar !== "\\"
    ) {
      break;
    }
    if (firstChar === "+") {
      additions += 1;
      parsedAdditions += 1;
    } else if (firstChar === "-") {
      deletions += 1;
      parsedDeletions += 1;
    } else if (firstChar === " ") {
      parsedAdditions += 1;
      parsedDeletions += 1;
    }
  }
  return { additions, deletions };
}

function summarizeFileHeader(lines: ReadonlyArray<string>, isGitDiff: boolean) {
  let name = "";
  let previousName: string | undefined;
  let type: UnifiedDiffFileType = "change";
  for (const line of lines) {
    if (line.startsWith("diff --git")) {
      const match = GIT_DIFF_HEADER.exec(line.trim());
      const quotedName = match?.[3];
      const plainName = match?.[4];
      if (
        match &&
        (match[1] ?? match[2]) !== undefined &&
        (quotedName ?? plainName) !== undefined
      ) {
        name = quotedName !== undefined ? unquoteGitPath(quotedName) : plainName!.trim();
      }
      continue;
    }
    const filenameMatch =
      line.startsWith("---") || line.startsWith("+++")
        ? (isGitDiff ? GIT_FILENAME_HEADER : UNIFIED_FILENAME_HEADER).exec(line)
        : null;
    if (filenameMatch) {
      const [, marker = "", first, second] = filenameMatch;
      const isDevNull = !isGitDiff && first === "/dev/null";
      const fileName = isGitDiff
        ? first !== undefined
          ? unquoteGitPath(first)
          : second!.trim()
        : first!.trim();
      if (isDevNull) continue;
      if (marker === "---") {
        previousName = fileName;
        name = fileName;
      } else {
        name = fileName;
      }
      continue;
    }
    if (!isGitDiff) continue;
    if (line.startsWith("new file mode")) type = "new";
    if (line.startsWith("deleted file mode")) type = "deleted";
    if (line.startsWith("similarity index")) {
      type = line.startsWith("similarity index 100%") ? "rename-pure" : "rename-changed";
    }
    if (line.startsWith("rename from ")) previousName = gitHeaderPath(line.slice(12));
    if (line.startsWith("rename to ")) name = gitHeaderPath(line.slice(10));
  }
  return { name, previousName, type };
}

function summarizeUnifiedDiffFile(
  contents: string,
  isGitDiff: boolean,
): UnifiedDiffFileSummary | null {
  let header: ReturnType<typeof summarizeFileHeader> | null = null;
  let hunkCount = 0;
  let additions = 0;
  let deletions = 0;
  for (const part of splitAtLinePrefix(contents, "@@ ")) {
    const lines = splitLines(part);
    if (lines.length === 0) continue;
    const hunkHeader = parseHunkHeader(lines[0]!);
    if (header === null) {
      header = summarizeFileHeader(lines, isGitDiff);
      continue;
    }
    if (hunkHeader === null) continue;
    const counts = countHunk(lines, hunkHeader);
    hunkCount += 1;
    additions += counts.additions;
    deletions += counts.deletions;
  }
  if (header === null) return null;
  const renamedWithoutGitHeader =
    !isGitDiff && header.previousName !== undefined && header.previousName !== header.name;
  return {
    name: header.name,
    type: renamedWithoutGitHeader
      ? hunkCount > 0
        ? "rename-changed"
        : "rename-pure"
      : header.type,
    additions,
    deletions,
  };
}

function summarizeUnifiedDiffPatch(patch: string): UnifiedDiffFileSummary[] {
  const isGitDiff = patch.startsWith("diff --git") || patch.includes("\ndiff --git");
  const blobs = isGitDiff ? splitAtLinePrefix(patch, "diff --git") : splitUnifiedDiffFiles(patch);
  return blobs.flatMap((blob) => {
    const lines = blob.split("\n", 2);
    const startsFile = isGitDiff
      ? blob.startsWith("diff --git")
      : isUnifiedHeaderLine(lines[0], "---") && isUnifiedHeaderLine(lines[1], "+++");
    const file = startsFile ? summarizeUnifiedDiffFile(blob, isGitDiff) : null;
    return file === null ? [] : [file];
  });
}

function summarizeUnifiedDiff(diff: string): UnifiedDiffFileSummary[] {
  const patches =
    diff.startsWith("From ") || diff.includes("\nFrom ")
      ? diff.split(COMMIT_METADATA_SPLIT)
      : [diff];
  return patches.flatMap(summarizeUnifiedDiffPatch);
}

function checkpointKindFromUnifiedDiffType(type: UnifiedDiffFileType): string {
  switch (type) {
    case "deleted":
      return "deleted";
    case "new":
      return "added";
    case "rename-pure":
    case "rename-changed":
      return "renamed";
    case "change":
      return "modified";
  }
}

function summarizeCheckpointFiles(
  files: ReadonlyArray<UnifiedDiffFileSummary>,
): OrchestrationCheckpointFile[] {
  const filesByPath = new Map<string, OrchestrationCheckpointFile>();
  for (const file of files) {
    const existing = filesByPath.get(file.name);
    filesByPath.set(file.name, {
      path: file.name,
      kind: checkpointKindFromUnifiedDiffType(file.type),
      additions: (existing?.additions ?? 0) + file.additions,
      deletions: (existing?.deletions ?? 0) + file.deletions,
    });
  }

  return Array.from(filesByPath.values()).toSorted((left, right) =>
    left.path.localeCompare(right.path),
  );
}

function checkpointKindFromRawStatus(status: string): string {
  switch (status.charAt(0)) {
    case "A":
    case "T":
      return "added";
    case "D":
      return "deleted";
    case "R":
    case "C":
      return "renamed";
    default:
      return "modified";
  }
}

function parseNumstatCount(value: string): number {
  const count = Number.parseInt(value, 10);
  return Number.isFinite(count) ? count : 0;
}

export function parseCheckpointFilesFromRawNumstat(output: string): OrchestrationCheckpointFile[] {
  const tokens = output.split("\0");
  const kindsByPath = new Map<string, string>();
  const countsByPath = new Map<string, { additions: number; deletions: number }>();
  let index = 0;

  while (index < tokens.length && tokens[index]!.startsWith(":")) {
    const status = tokens[index]!.split(" ").at(-1) ?? "";
    const hasSourcePath = status.startsWith("R") || status.startsWith("C");
    const path = tokens[index + (hasSourcePath ? 2 : 1)] ?? "";
    kindsByPath.set(path, checkpointKindFromRawStatus(status));
    index += hasSourcePath ? 3 : 2;
  }

  while (index < tokens.length) {
    const record = tokens[index]!;
    const additionsEnd = record.indexOf("\t");
    const deletionsEnd = record.indexOf("\t", additionsEnd + 1);
    if (additionsEnd <= 0 || deletionsEnd < 0) {
      index += 1;
      continue;
    }
    const additions = record.slice(0, additionsEnd);
    const deletions = record.slice(additionsEnd + 1, deletionsEnd);
    const inlinePath = record.slice(deletionsEnd + 1);
    const hasSourcePath = inlinePath.length === 0;
    const path = hasSourcePath ? (tokens[index + 2] ?? "") : inlinePath;
    countsByPath.set(path, {
      additions: parseNumstatCount(additions),
      deletions: parseNumstatCount(deletions),
    });
    index += hasSourcePath ? 3 : 1;
  }

  return Array.from(kindsByPath, ([path, kind]) => ({
    path,
    kind,
    additions: countsByPath.get(path)?.additions ?? 0,
    deletions: countsByPath.get(path)?.deletions ?? 0,
  })).toSorted((left, right) => left.path.localeCompare(right.path));
}

export function parseCheckpointFilesFromUnifiedDiff(
  diff: string,
): Effect.Effect<OrchestrationCheckpointFile[]> {
  return Effect.sync(() => {
    const normalized = diff.replace(/\r\n/g, "\n").trim();
    return normalized.length === 0
      ? []
      : summarizeCheckpointFiles(summarizeUnifiedDiff(normalized));
  });
}
