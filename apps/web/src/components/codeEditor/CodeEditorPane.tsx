import type { EditorOptions } from "@pierre/diffs/edit";
import { File } from "@pierre/diffs/react";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useMemo, useRef, type KeyboardEvent, type RefObject } from "react";

import type { ResolvedKeybindingsConfig } from "@synara/contracts";
import { isBrowserSaveChord } from "~/hooks/useWorkspaceFileEditorShortcuts";
import { buildDiffPanelUnsafeCSS, resolveDiffThemeName } from "~/lib/diffRendering";
import { isEditorFileSaveShortcut } from "~/keybindings";
import { serverConfigQueryOptions } from "~/lib/serverReactQuery";
import { CodeEditBoundary } from "./CodeEditBoundary";
import { useFileEditorFind } from "./useFileEditorFind";
import {
  createCodeEditHistoryControls,
  readCodeEditHistoryState,
  type CodeEditHistoryControls,
  type CodeEditHistoryState,
  type PierreEditor,
} from "./pierreEdit";

export interface CodeEditorPaneProps {
  value: string;
  valueVersion: number;
  fileName: string;
  documentKey?: string | undefined;
  language?: "text" | undefined;
  ariaLabel?: string | undefined;
  resolvedTheme: "light" | "dark";
  onChange: (value: string) => void;
  onSave: () => void;
  historyControlsRef?: RefObject<CodeEditHistoryControls | null> | undefined;
  onHistoryChange?: ((history: CodeEditHistoryState) => void) | undefined;
}

export function useCodeEditorSessionOptions(input: {
  onChange: (value: string) => void;
  onHistoryChange?: ((history: CodeEditHistoryState) => void) | undefined;
  historyControlsRef?: RefObject<CodeEditHistoryControls | null> | undefined;
  onAttach?: ((editor: PierreEditor) => void) | undefined;
  persistState?: boolean | undefined;
}): EditorOptions<undefined> {
  const onChangeRef = useRef(input.onChange);
  onChangeRef.current = input.onChange;
  const onHistoryChangeRef = useRef(input.onHistoryChange);
  onHistoryChangeRef.current = input.onHistoryChange;
  const historyControlsRef = input.historyControlsRef;
  const onAttachRef = useRef(input.onAttach);
  onAttachRef.current = input.onAttach;
  const editorRef = useRef<PierreEditor | null>(null);

  return useMemo(() => {
    let previousHistory: CodeEditHistoryState | undefined;
    const publishHistory = (editor: PierreEditor) => {
      const history = readCodeEditHistoryState(editor);
      // Most keystrokes change the buffer without changing toolbar availability.
      if (
        history.canUndo === previousHistory?.canUndo &&
        history.canRedo === previousHistory?.canRedo
      ) {
        return;
      }
      previousHistory = history;
      onHistoryChangeRef.current?.(history);
    };
    return {
      ...(input.persistState === undefined ? {} : { persistState: input.persistState }),
      onAttach: (editor: PierreEditor) => {
        editorRef.current = editor;
        onAttachRef.current?.(editor);
        if (historyControlsRef) {
          historyControlsRef.current = createCodeEditHistoryControls(editor);
        }
        publishHistory(editor);
      },
      onChange: (file: { contents: string }) => {
        onChangeRef.current(file.contents);
        const editor = editorRef.current;
        if (editor) {
          publishHistory(editor);
        }
      },
    };
  }, [historyControlsRef, input.persistState]);
}

const EMPTY_KEYBINDINGS: ResolvedKeybindingsConfig = [];

// Capture-phase save handling for the pierre editor: the editor hosts its own
// key handling, so saves are dispatched from the container. The chord is
// matched against the configured `editor.file.save` binding (not hard-coded
// Mod+S) so rebinds are honored, while the browser save dialog stays
// suppressed for the default chord regardless of the binding.
export function useCodeEditorSaveKeyDownHandler(onSave: () => void) {
  const serverConfigQuery = useQuery(serverConfigQueryOptions());
  const keybindings = serverConfigQuery.data?.keybindings ?? EMPTY_KEYBINDINGS;
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;
  return useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (isBrowserSaveChord(event)) {
        event.preventDefault();
      }
      if (!isEditorFileSaveShortcut(event, keybindings)) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      onSaveRef.current();
    },
    [keybindings],
  );
}

export function CodeEditorPane(props: CodeEditorPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const labelEditor = useFileEditorFind(containerRef, props.ariaLabel ?? `Edit ${props.fileName}`);
  const valueRef = useRef(props.value);
  valueRef.current = props.value;
  const file = useMemo(
    () => ({
      name: props.fileName,
      contents: valueRef.current,
      cacheKey: `edit:${props.documentKey ?? props.fileName}:${props.valueVersion}`,
      ...(props.language ? { lang: props.language } : {}),
    }),
    [props.fileName, props.documentKey, props.valueVersion, props.language],
  );
  const editorOptions = useCodeEditorSessionOptions({
    onChange: props.onChange,
    persistState: true,
    onHistoryChange: props.onHistoryChange,
    historyControlsRef: props.historyControlsRef,
    onAttach: labelEditor,
  });
  const options = useMemo(
    () => ({
      theme: resolveDiffThemeName(props.resolvedTheme),
      themeType: props.resolvedTheme,
      unsafeCSS: buildDiffPanelUnsafeCSS(props.resolvedTheme),
      disableFileHeader: true,
      overflow: "scroll" as const,
    }),
    [props.resolvedTheme],
  );

  const saveKeyDownHandler = useCodeEditorSaveKeyDownHandler(props.onSave);
  // Pierre owns live edits; only a reload or display change needs a React update.
  const content = useMemo(
    () => <File file={file} options={options} edit editorOptions={editorOptions} />,
    [file, options, editorOptions],
  );

  return (
    <div
      ref={containerRef}
      data-file-editor="true"
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
      onKeyDownCapture={saveKeyDownHandler}
    >
      <CodeEditBoundary>{content}</CodeEditBoundary>
    </div>
  );
}
