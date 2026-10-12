// FILE: ToolCallDetailsDialog.tsx
// Purpose: Inline details content for command and file-change transcript rows.
// Layer: Chat presentation component
// Exports: ToolCallDetailsContent
// Depends on: WorkLogEntry.toolDetails

import type { FileChangeEntry, TranscriptNotice, WebSearchResult } from "@synara/contracts";
import type { ReactNode } from "react";
import { useScrollTailFollow } from "~/hooks/useScrollTailFollow";
import { useTheme } from "~/hooks/useTheme";
import { getRenderablePatch, buildFileDiffRenderKey } from "~/lib/diffRendering";
import { Button } from "../ui/button";
import { ThreadId } from "@synara/contracts";
import type { WorkLogSubagent } from "../../workLog";
import { CopyTextButton } from "../ui/copyTextButton";
import { createMarkdownCodeFence, formatShellTranscript } from "~/lib/toolCallDetailsFormatting";
import { openExternalLink } from "~/lib/linkChips";
import { cn } from "~/lib/utils";
import { toAttachmentPreviewUrl } from "~/lib/wsHttpUrl";
import type { TimestampFormat } from "../../appSettings";
import {
  effectiveFileChangeMovePath,
  renderableFileChangePatch,
  webSearchResultLabel,
  withoutCombinedOutputWhenSplit,
  type CommandFooter,
  type ToolImageView,
  type TypedCommandView,
  type TypedToolCallView,
  type TypedWebSearchView,
  type WorkLogToolDetails,
  type WorkLogToolOutputDetails,
} from "../../lib/toolCallDetails";
import { readGroupedHookNoticeData } from "../../lib/transcriptNoticeLabels";
import type { WorkLogLiveActivity } from "../../workLog";
import {
  formatLiveActivityElapsed,
  formatLiveActivityProgress,
  formatLiveActivityStateLabel,
  useLiveActivityNow,
} from "../../lib/liveActivityPresentation";
import { formatTimestamp } from "../../timestampFormat";
import ChatMarkdown from "../ChatMarkdown";
import type { ExpandedImagePreview } from "./ExpandedImagePreview";
import { FileDiffCard } from "./FileDiffView";
import { GeneratedMarkdownImage } from "./GeneratedMarkdownImage";

const DETAIL_HEADER_CLASS_NAME = "border-b border-border/45 px-3 py-2 text-ui-xs font-medium";
const DETAIL_CODE_BLOCK_CLASS_NAME =
  "max-h-[min(46vh,30rem)] overflow-auto whitespace-pre-wrap break-words font-chat-code text-chat-code leading-relaxed text-foreground/88";
const TOOL_DETAILS_MARKDOWN_CLASS_NAME = "text-ui leading-relaxed";

export function ToolCallDetailsContent({
  details,
  activity,
  timestampFormat,
}: {
  details: WorkLogToolDetails | undefined;
  activity?: WorkLogLiveActivity | undefined;
  timestampFormat: TimestampFormat;
}) {
  if (!details && !activity) {
    return (
      <div className="rounded-lg border border-border/45 bg-background/60 px-3 py-2 text-ui leading-snug text-muted-foreground">
        No detailed payload was available for this tool call.
      </div>
    );
  }

  const output = details?.output ? withoutCombinedOutputWhenSplit(details.output) : undefined;

  return (
    <>
      {activity ? (
        <LiveActivityMetadata activity={activity} timestampFormat={timestampFormat} />
      ) : null}

      {details?.command ? (
        <div className="space-y-2">
          <MarkdownToolCodeBlock language="bash">
            {formatShellTranscript(details.command, output)}
          </MarkdownToolCodeBlock>
          {output ? <ToolOutputMetadata output={output} /> : null}
        </div>
      ) : null}

      {details?.files?.length ? (
        <ToolDetailSection title="Files">
          <div className="flex flex-wrap gap-1.5">
            {details.files.map((file) => (
              <span
                key={file}
                className="max-w-full rounded-md border border-border/45 bg-background/70 px-2 py-1 font-chat-code text-chat-code text-foreground/82"
                title={file}
              >
                {file}
              </span>
            ))}
          </div>
        </ToolDetailSection>
      ) : null}

      {details?.diff ? (
        <ToolDetailSection title="Diff">
          <DiffCodeBlock>{details.diff}</DiffCodeBlock>
        </ToolDetailSection>
      ) : null}

      {details?.edits?.length ? (
        <ToolDetailSection title="Edits">
          <div className="space-y-3">
            {details.edits.map((edit, index) => (
              <div
                key={`${edit.path ?? "edit"}:${index}`}
                className="overflow-hidden rounded-lg border border-border/45 bg-background/58"
              >
                {edit.path ? (
                  <div className="border-b border-border/45 px-3 py-2 font-chat-code text-chat-code text-muted-foreground/72">
                    {edit.path}
                  </div>
                ) : null}
                <div className="grid gap-0 md:grid-cols-2">
                  {edit.oldText !== undefined ? (
                    <TextChangeBlock title="Before" tone="remove">
                      {edit.oldText}
                    </TextChangeBlock>
                  ) : null}
                  {edit.newText !== undefined ? (
                    <TextChangeBlock title="After" tone="add">
                      {edit.newText}
                    </TextChangeBlock>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        </ToolDetailSection>
      ) : null}

      {details?.content ? (
        <ToolDetailSection title="Written Content">
          <MarkdownToolCodeBlock language="text">{details.content}</MarkdownToolCodeBlock>
        </ToolDetailSection>
      ) : null}

      {output && !details?.command ? <ToolOutputSection output={output} /> : null}
    </>
  );
}

function formatActivityTimestamp(value: string, timestampFormat: TimestampFormat): string {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    return value;
  }
  return formatTimestamp(value, timestampFormat);
}

function LiveActivityMetadata({
  activity,
  timestampFormat,
}: {
  activity: WorkLogLiveActivity;
  timestampFormat: TimestampFormat;
}) {
  const stateLabel = formatLiveActivityStateLabel(activity.state);
  const nowMs = useLiveActivityNow(activity);
  const elapsed = formatLiveActivityElapsed(activity, nowMs);
  const progress =
    activity.progress !== undefined ? formatLiveActivityProgress(activity.progress) : null;

  return (
    <ToolDetailSection title="Activity">
      <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1.5 rounded-lg border border-border/45 bg-background/60 px-3 py-2.5 text-ui-sm">
        <dt className="text-muted-foreground/56">Status</dt>
        <dd className="text-foreground/84">{stateLabel}</dd>
        {activity.startedAt ? (
          <>
            <dt className="text-muted-foreground/56">Started</dt>
            <dd className="text-foreground/84">
              <time dateTime={activity.startedAt} title={activity.startedAt}>
                {formatActivityTimestamp(activity.startedAt, timestampFormat)}
              </time>
            </dd>
          </>
        ) : null}
        <dt className="text-muted-foreground/56">Last activity</dt>
        <dd className="text-foreground/84">
          <time dateTime={activity.lastActivityAt} title={activity.lastActivityAt}>
            {formatActivityTimestamp(activity.lastActivityAt, timestampFormat)}
          </time>
        </dd>
        {elapsed ? (
          <>
            <dt className="text-muted-foreground/56">Elapsed</dt>
            <dd className="tabular-nums text-foreground/84">{elapsed}</dd>
          </>
        ) : null}
        {progress ? (
          <>
            <dt className="text-muted-foreground/56">Progress</dt>
            <dd className="tabular-nums text-foreground/84">{progress}</dd>
          </>
        ) : null}
        {activity.detail ? (
          <>
            <dt className="text-muted-foreground/56">Detail</dt>
            <dd className="break-words text-foreground/84">{activity.detail}</dd>
          </>
        ) : null}
      </dl>
    </ToolDetailSection>
  );
}

function MarkdownToolCodeBlock(props: { language: string; children: string }) {
  return (
    <ChatMarkdown
      text={createMarkdownCodeFence(props.language, props.children)}
      cwd={undefined}
      className={TOOL_DETAILS_MARKDOWN_CLASS_NAME}
    />
  );
}

function ToolDetailSection(props: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-ui-sm font-medium text-muted-foreground/56">{props.title}</h3>
      {props.children}
    </section>
  );
}

function ToolOutputMetadata({ output }: { output: WorkLogToolOutputDetails }) {
  if (output.exitCode === undefined && !output.truncated) {
    return null;
  }
  return (
    <div className="flex flex-wrap items-center gap-2 text-ui-sm text-muted-foreground/68">
      {output.exitCode !== undefined ? (
        <span className="rounded-full border border-border/45 px-2 py-0.5">
          Exit code {output.exitCode}
        </span>
      ) : null}
      {output.truncated ? (
        <span className="rounded-full border border-amber-500/30 bg-amber-500/8 px-2 py-0.5 text-amber-200/90">
          Truncated
        </span>
      ) : null}
    </div>
  );
}

function ToolOutputSection({ output }: { output: WorkLogToolOutputDetails }) {
  return (
    <ToolDetailSection title="Output">
      <div className="space-y-3">
        {output.output ? (
          <MarkdownToolCodeBlock language="text">{output.output}</MarkdownToolCodeBlock>
        ) : null}
        {output.stdout ? (
          <LabeledCodeBlock title="Stdout" tone="output">
            {output.stdout}
          </LabeledCodeBlock>
        ) : null}
        {output.stderr ? (
          <LabeledCodeBlock title="Stderr" tone="error">
            {output.stderr}
          </LabeledCodeBlock>
        ) : null}
        <ToolOutputMetadata output={output} />
      </div>
    </ToolDetailSection>
  );
}

function LabeledCodeBlock(props: { title: string; tone: "output" | "error"; children: string }) {
  return (
    <div className="overflow-hidden rounded-lg border border-border/45 bg-background/58">
      <div
        className={cn(
          DETAIL_HEADER_CLASS_NAME,
          props.tone === "error" ? "text-rose-200/88" : "text-muted-foreground/60",
        )}
      >
        {props.title}
      </div>
      <ToolCodeBlock bare>{props.children}</ToolCodeBlock>
    </div>
  );
}

function TextChangeBlock(props: { title: string; tone: "add" | "remove"; children: string }) {
  return (
    <div
      className={cn(
        "min-w-0 border-border/45 md:[&:not(:first-child)]:border-l",
        props.tone === "add" ? "bg-emerald-500/5" : "bg-rose-500/5",
      )}
    >
      <div
        className={cn(
          DETAIL_HEADER_CLASS_NAME,
          props.tone === "add" ? "text-emerald-200/82" : "text-rose-200/82",
        )}
      >
        {props.title}
      </div>
      <ToolCodeBlock bare>{props.children}</ToolCodeBlock>
    </div>
  );
}

function ToolCodeBlock(props: { children: string; tone?: "default" | "command"; bare?: boolean }) {
  return (
    <pre
      className={cn(
        DETAIL_CODE_BLOCK_CLASS_NAME,
        props.tone === "command" && "text-sky-100/92",
        props.bare
          ? "px-3 py-2.5"
          : "rounded-lg border border-border/45 bg-background/70 px-3 py-2.5",
      )}
    >
      {props.children}
    </pre>
  );
}

function DiffCodeBlock({ children }: { children: string }) {
  const lines = children.split(/\r?\n/);
  return (
    <pre className="max-h-[min(52vh,34rem)] overflow-auto rounded-lg border border-border/45 bg-background/70 px-0 py-2 font-chat-code text-chat-code leading-relaxed">
      {lines.map((line, index) => (
        <span
          key={`${index}:${line.slice(0, 24)}`}
          className={cn(
            "block min-w-max whitespace-pre-wrap break-words px-3",
            line.startsWith("+") && !line.startsWith("+++")
              ? "bg-emerald-500/8 text-emerald-100/92"
              : null,
            line.startsWith("-") && !line.startsWith("---")
              ? "bg-rose-500/8 text-rose-100/92"
              : null,
            line.startsWith("@@") ? "text-sky-200/90" : null,
            /^(diff --git|index |--- |\+\+\+ )/.test(line) ? "text-muted-foreground/62" : null,
          )}
        >
          {line.length > 0 ? line : " "}
        </span>
      ))}
    </pre>
  );
}

const PLAIN_TEXT_BLOCK_CLASS_NAME =
  "max-h-80 overflow-auto whitespace-pre-wrap break-words font-chat-code text-chat-code leading-relaxed text-foreground/88";
const DETAIL_CARD_CLASS_NAME =
  "overflow-hidden rounded-lg border border-border/45 bg-background/58";

const COMMAND_FOOTER_TONE_CLASS_NAME: Record<CommandFooter["tone"], string> = {
  success: "text-emerald-600 dark:text-emerald-300/90",
  error: "text-destructive/85",
  muted: "text-muted-foreground/68",
};

function withOccurrenceKeys<Item>(
  items: ReadonlyArray<Item>,
  identity: (item: Item) => string,
): Array<{ key: string; item: Item }> {
  const seen = new Map<string, number>();
  return items.map((item) => {
    const id = identity(item);
    const occurrence = seen.get(id) ?? 0;
    seen.set(id, occurrence + 1);
    return { key: `${id}#${occurrence}`, item };
  });
}

function TruncatedNote(props: { children: string }) {
  return <p className="text-ui-xs text-muted-foreground/60">{props.children}</p>;
}

function PlainTextBlock(props: {
  children: string;
  tone?: "default" | "error";
  dataAttr?: string;
  followTail?: boolean;
}) {
  const tailFollow = useScrollTailFollow<HTMLPreElement>({
    enabled: props.followTail === true,
    content: props.children,
  });
  return (
    <pre
      ref={tailFollow.ref}
      onScroll={tailFollow.onScroll}
      className={cn(
        PLAIN_TEXT_BLOCK_CLASS_NAME,
        "px-3 py-2.5",
        props.tone === "error" && "text-destructive/85",
      )}
      {...(props.dataAttr ? { [props.dataAttr]: "true" } : {})}
    >
      {props.children}
    </pre>
  );
}

export function TypedCommandDetails(props: { view: TypedCommandView; running: boolean }) {
  const { view, running } = props;
  const hasSplitOutput = Boolean(view.stdout || view.stderr);
  const emptyOutput = !view.output && !hasSplitOutput;
  const outputStreaming = running || view.isLiveOutput;
  return (
    <div className={DETAIL_CARD_CLASS_NAME} data-command-shell-card="true">
      <div className="space-y-1 border-b border-border/45 px-3 py-2">
        {view.command ? <CopyTextButton text={view.command} label="command" /> : null}
        {view.command ? (
          <pre className="whitespace-pre-wrap break-words font-chat-code text-chat-code text-foreground/92">
            <span className="select-none text-muted-foreground/60">$ </span>
            {view.command}
          </pre>
        ) : null}
        {view.cwd ? (
          <p className="truncate text-ui-xs text-muted-foreground/60" title={view.cwd}>
            {view.cwd}
          </p>
        ) : null}
        {view.description ? (
          <p className="text-ui-xs text-muted-foreground/68">{view.description}</p>
        ) : null}
      </div>
      {view.output ? (
        <div className="px-3 pt-1">
          <CopyTextButton text={view.output} label="output" />
        </div>
      ) : null}
      {view.output ? (
        <PlainTextBlock
          dataAttr={view.isLiveOutput ? "data-command-live-output" : "data-command-output"}
          followTail={outputStreaming}
        >
          {view.output}
        </PlainTextBlock>
      ) : null}
      {view.stdout ? (
        <div data-command-stdout="true">
          <div className="px-3 pt-1">
            <CopyTextButton text={view.stdout} label="stdout" />
          </div>
          {view.stderr ? <div className={DETAIL_HEADER_CLASS_NAME}>Stdout</div> : null}
          <PlainTextBlock followTail={outputStreaming}>{view.stdout}</PlainTextBlock>
        </div>
      ) : null}
      {view.stderr ? (
        <div data-command-stderr="true">
          <div className="px-3 pt-1">
            <CopyTextButton text={view.stderr} label="stderr" />
          </div>
          <div className={cn(DETAIL_HEADER_CLASS_NAME, "text-destructive/80")}>Stderr</div>
          <PlainTextBlock tone="error" followTail={outputStreaming}>
            {view.stderr}
          </PlainTextBlock>
        </div>
      ) : null}
      {emptyOutput ? (
        <p className="px-3 py-2 text-ui-sm text-muted-foreground/60">
          {running ? "Waiting for output" : "No output"}
        </p>
      ) : null}
      {view.lastStdin ? (
        <p className="border-t border-border/45 px-3 py-1.5 text-ui-xs text-muted-foreground/68">
          Sent input: <span className="font-chat-code text-chat-code">{view.lastStdin}</span>
        </p>
      ) : null}
      {view.footer || view.outputTruncated ? (
        <div className="flex items-center gap-3 border-t border-border/45 px-3 py-1.5 text-ui-xs">
          {view.footer ? (
            <span
              className={cn("font-medium", COMMAND_FOOTER_TONE_CLASS_NAME[view.footer.tone])}
              data-command-footer="true"
            >
              {view.footer.label}
            </span>
          ) : null}
          {view.outputTruncated ? (
            <span className="text-muted-foreground/60">
              {view.outputTotalChars
                ? `Showing the end of ${view.outputTotalChars.toLocaleString()} characters`
                : "Output truncated"}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function FileChangeDiffDetails(props: {
  change: FileChangeEntry;
  cwd?: string | undefined;
  onOpenTurnDiff?: (() => void) | undefined;
}) {
  const { change } = props;
  const { resolvedTheme } = useTheme();
  const theme = resolvedTheme === "dark" ? "dark" : "light";
  const renderable = getRenderablePatch(
    renderableFileChangePatch(change, props.cwd),
    "transcript-file-change",
  );
  const movePath = effectiveFileChangeMovePath(change, props.cwd);
  return (
    <div className="space-y-2" data-file-change-diff="true">
      {movePath ? (
        <p className="text-ui-xs text-muted-foreground/68">
          {change.path} → {movePath}
        </p>
      ) : null}
      {renderable?.kind === "files" ? (
        <div className="max-h-96 overflow-auto rounded-lg border border-border/45">
          {renderable.files.map((fileDiff) => (
            <FileDiffCard
              key={buildFileDiffRenderKey(fileDiff)}
              fileDiff={fileDiff}
              theme={theme}
              overflow="wrap"
            />
          ))}
        </div>
      ) : renderable?.kind === "raw" ? (
        <DiffCodeBlock>{renderable.text}</DiffCodeBlock>
      ) : (
        <p className="text-ui-sm text-muted-foreground/60">
          {change.kind === "delete" ? "Contents deleted" : "No diff available"}
        </p>
      )}
      {change.diffTruncated ? (
        <TruncatedNote>Diff too large to preview in full</TruncatedNote>
      ) : null}
      {props.onOpenTurnDiff ? (
        <button
          type="button"
          className="text-ui-sm text-muted-foreground/72 underline-offset-2 hover:text-foreground hover:underline"
          data-open-turn-diff="true"
          onClick={props.onOpenTurnDiff}
        >
          Open in turn diff
        </button>
      ) : null}
    </div>
  );
}

function ToolImageThumbnail(props: {
  image: ToolImageView;
  images: ReadonlyArray<ToolImageView>;
  markdownCwd: string | undefined;
  onImageExpand?: ((preview: ExpandedImagePreview) => void) | undefined;
}) {
  const { image } = props;
  if (image.kind === "omitted" || !image.src) {
    return (
      <span
        className="rounded-md border border-border/45 bg-background/70 px-2 py-1 text-ui-xs text-muted-foreground/68"
        data-tool-image-omitted="true"
      >
        {image.label}: {image.reason}
      </span>
    );
  }
  if (image.kind === "local-file") {
    return (
      <div className="max-w-64" data-tool-image="local">
        <GeneratedMarkdownImage
          src={image.src}
          alt={image.label}
          cwd={props.markdownCwd}
          onImageExpand={props.onImageExpand}
        />
      </div>
    );
  }
  const previewUrl = toAttachmentPreviewUrl(image.src);
  const expandable = props.images.filter((entry) => entry.kind === "attachment" && entry.src);
  return (
    <button
      type="button"
      className="overflow-hidden rounded-md border border-border/45 bg-background/70"
      data-tool-image="attachment"
      aria-label={`Open ${image.label}`}
      onClick={() =>
        props.onImageExpand?.({
          images: expandable.map((entry) => ({
            src: toAttachmentPreviewUrl(entry.src!),
            name: entry.label,
          })),
          index: Math.max(
            0,
            expandable.findIndex((entry) => entry.key === image.key),
          ),
        })
      }
    >
      <img
        src={previewUrl}
        alt={image.label}
        loading="lazy"
        className="max-h-40 max-w-64 object-contain"
      />
    </button>
  );
}

export function TypedToolCallDetails(props: {
  view: TypedToolCallView;
  running: boolean;
  markdownCwd: string | undefined;
  onImageExpand?: ((preview: ExpandedImagePreview) => void) | undefined;
}) {
  const { view } = props;
  if (view.isEmpty) {
    return (
      <p className="text-ui-sm text-muted-foreground/60">
        {props.running ? "Waiting for the tool to finish" : "Tool returned no content"}
      </p>
    );
  }
  return (
    <div className="space-y-3" data-typed-tool-details="true">
      {view.server ? (
        <p className="text-ui-xs text-muted-foreground/60">Server: {view.server}</p>
      ) : null}
      {view.argumentsText ? (
        <ToolDetailSection title="Arguments">
          <div className={DETAIL_CARD_CLASS_NAME}>
            <PlainTextBlock>{view.argumentsText}</PlainTextBlock>
          </div>
          {view.argumentsTruncated ? <TruncatedNote>Arguments truncated</TruncatedNote> : null}
        </ToolDetailSection>
      ) : null}
      {view.error ? (
        <ToolDetailSection title="Error">
          <div className={cn(DETAIL_CARD_CLASS_NAME, "border-destructive/30")}>
            <PlainTextBlock tone="error" dataAttr="data-tool-error">
              {view.error}
            </PlainTextBlock>
          </div>
        </ToolDetailSection>
      ) : null}
      {view.resultText ? (
        <ToolDetailSection title="Result">
          <div className={DETAIL_CARD_CLASS_NAME}>
            <PlainTextBlock dataAttr="data-tool-result">{view.resultText}</PlainTextBlock>
          </div>
          {view.resultTruncated ? <TruncatedNote>Result truncated</TruncatedNote> : null}
        </ToolDetailSection>
      ) : null}
      {view.structuredContentText ? (
        <ToolDetailSection title="Structured content">
          <div className={DETAIL_CARD_CLASS_NAME}>
            <PlainTextBlock>{view.structuredContentText}</PlainTextBlock>
          </div>
        </ToolDetailSection>
      ) : null}
      {view.images.length > 0 ? (
        <ToolDetailSection title="Images">
          <div className="flex flex-wrap items-start gap-2">
            {view.images.map((image) => (
              <ToolImageThumbnail
                key={image.key}
                image={image}
                images={view.images}
                markdownCwd={props.markdownCwd}
                onImageExpand={props.onImageExpand}
              />
            ))}
          </div>
        </ToolDetailSection>
      ) : null}
      {view.otherBlocks.length > 0 ? (
        <ToolDetailSection title="Other content">
          <ul className="space-y-1 text-ui-sm text-foreground/80">
            {withOccurrenceKeys(view.otherBlocks, (block) => block).map(({ key, item }) => (
              <li key={key} className="break-words">
                {item}
              </li>
            ))}
          </ul>
        </ToolDetailSection>
      ) : null}
    </div>
  );
}

function isHttpUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

function WebSearchResultLink(props: { result: WebSearchResult }) {
  const url = props.result.url.trim();
  const label = webSearchResultLabel(props.result);
  if (!isHttpUrl(url)) {
    return (
      <span className="block truncate text-foreground/84" title={url}>
        {label}
      </span>
    );
  }
  return (
    <a
      href={url}
      rel="noreferrer noopener"
      className="block truncate text-foreground/84 underline-offset-2 hover:underline"
      title={url}
      data-web-search-result-link="true"
      onClick={(event) => {
        event.preventDefault();
        openExternalLink(url);
      }}
    >
      {label}
    </a>
  );
}

export function TypedWebSearchDetails(props: { view: TypedWebSearchView }) {
  const { view } = props;
  return (
    <div className="space-y-3 text-ui-sm" data-web-search-details="true">
      {view.queries.length > 0 ? (
        <ToolDetailSection title={view.queries.length > 1 ? "Queries" : "Query"}>
          <ul className="space-y-0.5 text-foreground/84">
            {view.queries.map((query) => (
              <li key={query} className="break-words">
                {query}
              </li>
            ))}
          </ul>
        </ToolDetailSection>
      ) : null}
      {view.url ? (
        <p className="break-all text-muted-foreground/72">
          {view.pattern ? `Looked for '${view.pattern}' in ` : "Opened "}
          {view.url}
        </p>
      ) : null}
      {view.allowedDomains.length > 0 ? (
        <p className="text-muted-foreground/68">Only: {view.allowedDomains.join(", ")}</p>
      ) : null}
      {view.blockedDomains.length > 0 ? (
        <p className="text-muted-foreground/68">Excluded: {view.blockedDomains.join(", ")}</p>
      ) : null}
      {view.results.length > 0 ? (
        <ToolDetailSection title="Results">
          <ul className="space-y-1">
            {withOccurrenceKeys(view.results, (result) => result.url).map(
              ({ key, item: result }) => (
                <li key={key} className="min-w-0">
                  <WebSearchResultLink result={result} />
                </li>
              ),
            )}
          </ul>
          {view.resultsTruncated ? (
            <TruncatedNote>More results were not stored</TruncatedNote>
          ) : null}
        </ToolDetailSection>
      ) : null}
      {view.error ? <p className="text-destructive/85">{view.error}</p> : null}
    </div>
  );
}

export interface SubagentLaunchView {
  status: string;
  model: string | null;
  prompt: string | null;
  agents?: ReadonlyArray<WorkLogSubagent> | undefined;
}

export function SubagentLaunchDetails(props: {
  view: SubagentLaunchView;
  onOpenThread?: ((threadId: ThreadId) => void) | undefined;
}) {
  const { view } = props;
  return (
    <div className="space-y-3" data-subagent-launch-details="true">
      {view.agents?.map((agent) => (
        <div key={agent.threadId} className="space-y-1 text-ui-sm" data-subagent-history="true">
          <p>
            {agent.title ?? agent.nickname ?? agent.threadId} ·{" "}
            {agent.statusLabel ?? agent.rawStatus ?? view.status}
          </p>
          {agent.latestUpdate ? <p className="whitespace-pre-wrap">{agent.latestUpdate}</p> : null}
          {agent.prompt && agent.prompt !== view.prompt ? (
            <PlainTextBlock>{agent.prompt}</PlainTextBlock>
          ) : null}
          {agent.resolvedThreadId && props.onOpenThread ? (
            <Button
              size="xs"
              variant="ghost"
              onClick={() => props.onOpenThread?.(ThreadId.makeUnsafe(agent.resolvedThreadId!))}
            >
              Open subagent thread
            </Button>
          ) : null}
        </div>
      ))}
      <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1.5 rounded-lg border border-border/45 bg-background/60 px-3 py-2.5 text-ui-sm">
        <dt className="text-muted-foreground/56">Status</dt>
        <dd className="text-foreground/84">{view.status}</dd>
        {view.model ? (
          <>
            <dt className="text-muted-foreground/56">Model</dt>
            <dd className="break-words text-foreground/84">{view.model}</dd>
          </>
        ) : null}
      </dl>
      {view.prompt ? (
        <ToolDetailSection title="Prompt">
          <div className={DETAIL_CARD_CLASS_NAME}>
            <PlainTextBlock dataAttr="data-subagent-prompt">{view.prompt}</PlainTextBlock>
          </div>
        </ToolDetailSection>
      ) : null}
    </div>
  );
}

export function TranscriptNoticeDetails(props: { notice: TranscriptNotice }) {
  const { notice } = props;
  const grouped = readGroupedHookNoticeData(notice);
  return (
    <div className="space-y-2" data-transcript-notice-details="true">
      {notice.detail ? (
        <p className="whitespace-pre-wrap break-words text-ui-sm text-muted-foreground/72">
          {notice.detail}
        </p>
      ) : null}
      {grouped && grouped.hookEvents.length > 0 ? (
        <p className="text-ui-sm text-muted-foreground/72">{grouped.hookEvents.join(", ")}</p>
      ) : null}
      {notice.body ? (
        <div className={DETAIL_CARD_CLASS_NAME}>
          <PlainTextBlock dataAttr="data-transcript-notice-body">{notice.body}</PlainTextBlock>
        </div>
      ) : null}
      {notice.bodyTruncated ? <TruncatedNote>Text truncated</TruncatedNote> : null}
    </div>
  );
}

export function ReasoningSummaryDetails(props: { summary: string; truncated: boolean }) {
  return (
    <div className="space-y-2" data-reasoning-summary="true">
      <p className="whitespace-pre-wrap break-words text-ui-sm leading-relaxed text-muted-foreground/80">
        {props.summary}
      </p>
      {props.truncated ? <TruncatedNote>Reasoning truncated</TruncatedNote> : null}
    </div>
  );
}
