// FILE: ComposerQueuedHeader.tsx
// Purpose: Queued follow-up rows shown as a panel that merges into the top of the
// composer input (each with Steer / Delete / Edit actions). Rounded only on top with
// a flat, borderless bottom that fuses flush onto the composer; spans the full composer
// width while the composer below keeps its own full rounding.
// Layer: Chat composer UI
// Exports: ComposerQueuedHeader

import { useId, useState } from "react";
import { pluralize } from "@synara/shared/text";

import type { QueuedComposerTurn } from "../../composerDraftStore";
import { SteerIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import ChatMarkdown from "../ChatMarkdown";
import { DisclosureChevron } from "../ui/DisclosureChevron";
import { DisclosureRegion } from "../ui/DisclosureRegion";
import { IconButton } from "../ui/icon-button";
import {
  ComposerStackedPanelRow,
  ComposerStackedPanelRowMain,
} from "./ComposerStackedPanelContent";
import {
  COMPOSER_STACKED_PANEL_DIVIDER_CLASS_NAME,
  ComposerStackedPanel,
} from "./ComposerStackedPanel";
import {
  COMPOSER_STACKED_PANEL_BODY_PADDING_CLASS_NAME,
  COMPOSER_STACKED_PANEL_ICON_CLASS_NAME,
  COMPOSER_STACKED_PANEL_PREVIEW_MARKDOWN_CLASS_NAME,
} from "./composerStackedPanelStyles";
import { QueuedComposerActions } from "./QueuedComposerActions";

function firstNonEmptyLine(value: string): string {
  return (
    value
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0)
      ?.trim() ?? ""
  );
}

// Queue previews use the shared markdown renderer for inline chips/emphasis, but
// must stay a single composer row even when the queued prompt is a heading, list,
// or fenced code block.
export function compactQueuedComposerPreviewMarkdown(value: string): string {
  const firstLine = firstNonEmptyLine(value);
  if (firstLine.length === 0) {
    return "Queued follow-up";
  }
  if (/^(?:`{3,}|~{3,})/.test(firstLine)) {
    return "Code block";
  }
  const normalized = firstLine
    .replace(/^#{1,6}\s+/, "")
    .replace(/^>\s?/, "")
    .replace(/^- \[[ xX]\]\s+/, "")
    .replace(/^[-*+]\s+/, "")
    .replace(/^\d+[.)]\s+/, "")
    .trim();
  return normalized.length > 0 ? normalized : "Queued follow-up";
}

export function queuedComposerTurnAttachmentSummary(queuedTurn: QueuedComposerTurn): string | null {
  if (queuedTurn.kind !== "chat") {
    return null;
  }
  const counts: ReadonlyArray<readonly [number, string]> = [
    [queuedTurn.persistedImages?.length ?? queuedTurn.images.length, "image"],
    [queuedTurn.persistedFiles?.length ?? queuedTurn.files.length, "file"],
    [queuedTurn.pastedTexts.length, "pasted text"],
    [queuedTurn.terminalContexts.length, "terminal context"],
    [queuedTurn.fileComments.length, "file comment"],
    [queuedTurn.assistantSelections.length, "selection"],
    [queuedTurn.browserAnnotations.length, "browser annotation"],
    [queuedTurn.pullRequestContexts.length, "pull request"],
  ];
  const parts = counts
    .filter(([count]) => count > 0)
    .map(([count, noun]) => `${count} ${pluralize(count, noun)}`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

function queuedComposerTurnFullText(queuedTurn: QueuedComposerTurn): string {
  return queuedTurn.kind === "chat" ? queuedTurn.prompt : queuedTurn.text;
}

interface QueuedFollowUpRowProps {
  queuedTurn: QueuedComposerTurn;
  showDivider: boolean;
  onSteer: (queuedTurn: QueuedComposerTurn) => void;
  onRemove: (queuedTurnId: string) => void;
  onEdit: (queuedTurn: QueuedComposerTurn) => void;
  cwd: string | undefined;
}

function QueuedFollowUpRow({
  queuedTurn,
  showDivider,
  onSteer,
  onRemove,
  onEdit,
  cwd,
}: QueuedFollowUpRowProps) {
  const [expanded, setExpanded] = useState(false);
  const previewRegionId = useId();
  const attachmentSummary = queuedComposerTurnAttachmentSummary(queuedTurn);

  return (
    <div className={cn(showDivider && COMPOSER_STACKED_PANEL_DIVIDER_CLASS_NAME)}>
      <ComposerStackedPanelRow compact data-testid="queued-follow-up-row">
        <ComposerStackedPanelRowMain>
          <SteerIcon className={COMPOSER_STACKED_PANEL_ICON_CLASS_NAME} />
          <ChatMarkdown
            text={compactQueuedComposerPreviewMarkdown(queuedTurn.previewText)}
            cwd={cwd}
            isStreaming={false}
            className={COMPOSER_STACKED_PANEL_PREVIEW_MARKDOWN_CLASS_NAME}
          />
        </ComposerStackedPanelRowMain>
        <IconButton
          variant="ghost"
          size="icon-chip"
          label={expanded ? "Hide full queued follow-up" : "Show full queued follow-up"}
          aria-expanded={expanded}
          aria-controls={previewRegionId}
          onClick={() => setExpanded((current) => !current)}
        >
          <DisclosureChevron open={expanded} />
        </IconButton>
        <QueuedComposerActions
          queuedTurn={queuedTurn}
          onSteer={onSteer}
          onRemove={onRemove}
          onEdit={onEdit}
        />
      </ComposerStackedPanelRow>
      <DisclosureRegion open={expanded}>
        <div
          id={previewRegionId}
          className={cn(
            COMPOSER_STACKED_PANEL_BODY_PADDING_CLASS_NAME,
            "max-h-48 overflow-y-auto text-ui-sm leading-snug",
          )}
        >
          <p className="whitespace-pre-wrap break-words text-foreground/85">
            {queuedComposerTurnFullText(queuedTurn)}
          </p>
          {attachmentSummary ? (
            <p className="mt-1 text-muted-foreground/80">{attachmentSummary}</p>
          ) : null}
        </div>
      </DisclosureRegion>
    </div>
  );
}

interface ComposerQueuedHeaderProps {
  queuedTurns: QueuedComposerTurn[];
  onSteer: (queuedTurn: QueuedComposerTurn) => void;
  onRemove: (queuedTurnId: string) => void;
  onEdit: (queuedTurn: QueuedComposerTurn) => void;
  /** Workspace root used to resolve local file links/mentions inside the parsed preview. */
  cwd?: string | undefined;
  attachedToPrevious?: boolean;
}

export const ComposerQueuedHeader = function ComposerQueuedHeader({
  queuedTurns,
  onSteer,
  onRemove,
  onEdit,
  cwd,
  attachedToPrevious: attachedToPreviousProp,
}: ComposerQueuedHeaderProps) {
  const attachedToPrevious = attachedToPreviousProp ?? false;
  if (queuedTurns.length === 0) {
    return null;
  }

  return (
    <ComposerStackedPanel attachedToPrevious={attachedToPrevious} className="flex flex-col">
      {queuedTurns.map((queuedTurn, queuedTurnIndex) => (
        <QueuedFollowUpRow
          key={queuedTurn.id}
          queuedTurn={queuedTurn}
          showDivider={queuedTurnIndex > 0}
          onSteer={onSteer}
          onRemove={onRemove}
          onEdit={onEdit}
          cwd={cwd}
        />
      ))}
    </ComposerStackedPanel>
  );
};
