// FILE: DockFilePane.tsx
// Purpose: Right-dock pane that previews one workspace file through the shared
//          WorkspaceFilePreview. Markdown opens already parsed (rendered); the
//          shared header carries the source toggle and open-in-editor controls.
// Layer: Chat right-dock UI
// Exports: DockFilePane

import { useMemo } from "react";

import { useFocusedChatContext } from "~/focusedChatContext";
import type { ChatFileReference } from "~/lib/chatReferences";
import type { FileCommentSelection } from "~/lib/fileComments";
import { WorkspaceFilePreview } from "../WorkspaceFilePreview";
import { PanelStateMessage } from "./PanelStateMessage";

export function DockFilePane(props: {
  workspaceRoot: string | null;
  filePath: string | null;
  isVisible: boolean;
  onReferenceInChat?: ((reference: ChatFileReference) => void) | undefined;
  onAskWhyInChat?: ((reference: ChatFileReference) => void) | undefined;
  onCommentInChat?: ((comment: FileCommentSelection) => void) | undefined;
}) {
  const { activeProjectId, focusedThreadId } = useFocusedChatContext();
  const pluginContext = useMemo(
    () => ({ projectId: activeProjectId, threadId: focusedThreadId }),
    [activeProjectId, focusedThreadId],
  );

  return (
    <WorkspaceFilePreview
      workspaceRoot={props.workspaceRoot}
      filePath={props.filePath}
      liveRevalidationEnabled={props.isVisible}
      markdownPreviewDefault
      pluginContext={pluginContext}
      emptyState={
        <PanelStateMessage density="compact" fill="flex">
          <p>Click a file in the chat to preview it here.</p>
        </PanelStateMessage>
      }
      onReferenceInChat={props.onReferenceInChat}
      onAskWhyInChat={props.onAskWhyInChat}
      onCommentInChat={props.onCommentInChat}
    />
  );
}
