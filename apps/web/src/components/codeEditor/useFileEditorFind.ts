import { useCallback, useEffect, useRef, type RefObject } from "react";
import type { PierreEditor } from "./pierreEdit";

export function useFileEditorFind(
  containerRef: RefObject<HTMLDivElement | null>,
  editorRef: RefObject<PierreEditor | null>,
  label: string,
) {
  const observerRef = useRef<MutationObserver | null>(null);
  const hadSearch = useRef(false);
  const update = useCallback(() => {
    const host = containerRef.current?.querySelector("diffs-container");
    const root = host?.shadowRoot;
    if (!root) return;
    const editable = root.querySelector('[contenteditable="true"]');
    if (editable && editable.getAttribute("aria-label") !== label) {
      editable.setAttribute("aria-label", label);
    }
    const search = root.querySelector<HTMLInputElement>("input[data-search]");
    if (search && search.getAttribute("aria-label") !== "Find in file") {
      search.setAttribute("aria-label", "Find in file");
    }
    if (
      hadSearch.current &&
      !search &&
      (document.activeElement === host || document.activeElement === document.body)
    ) {
      editorRef.current?.focus({ preventScroll: true });
    }
    hadSearch.current = search !== null;
    observerRef.current?.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["contenteditable", "aria-label"],
    });
  }, [containerRef, editorRef, label]);
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new MutationObserver(update);
    observerRef.current = observer;
    observer.observe(container, { childList: true, subtree: true });
    update();
    return () => {
      observer.disconnect();
      observerRef.current = null;
    };
  }, [containerRef, update]);
  return update;
}

export function eventTargetsFileEditor(
  event: Pick<globalThis.KeyboardEvent, "composedPath">,
): boolean {
  return event
    .composedPath()
    .some((target) => target instanceof HTMLElement && target.hasAttribute("data-file-editor"));
}
