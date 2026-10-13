import { WorkerPoolContext, useWorkerPool } from "@pierre/diffs/react";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useTheme } from "../hooks/useTheme";
import { resolveDiffThemeName, type DiffThemeName } from "../lib/diffRendering";
import {
  getDiffWorkerPool,
  setDiffWorkerWorkload,
  subscribeDiffWorkerPool,
} from "../lib/diffWorkerPool";

function DiffWorkerThemeSync({ themeName }: { themeName: DiffThemeName }) {
  const workerPool = useWorkerPool();

  useEffect(() => {
    if (!workerPool) {
      return;
    }

    const current = workerPool.getDiffRenderOptions();
    if (current.theme === themeName) {
      return;
    }

    void workerPool
      .setRenderOptions({
        ...current,
        theme: themeName,
      })
      .catch(() => undefined);
  }, [themeName, workerPool]);

  return null;
}

export function DiffWorkerPoolProvider({
  children,
  enabled = true,
  fileCount,
}: {
  children?: ReactNode;
  enabled?: boolean;
  fileCount: number;
}) {
  const [owner] = useState(() => Symbol("diff-surface"));
  const [workload, setWorkload] = useState(enabled ? fileCount : 0);
  const { resolvedTheme } = useTheme();
  const diffThemeName = resolveDiffThemeName(resolvedTheme);
  const themeRef = useRef(diffThemeName);
  themeRef.current = diffThemeName;
  const { pool, generation } = useSyncExternalStore(
    subscribeDiffWorkerPool,
    getDiffWorkerPool,
    getDiffWorkerPool,
  );

  if (enabled && fileCount > 0 && workload !== fileCount) setWorkload(fileCount);
  useLayoutEffect(() => {
    setDiffWorkerWorkload(owner, workload, diffThemeName);
  }, [owner, workload, diffThemeName]);
  useEffect(() => () => setDiffWorkerWorkload(owner, 0, themeRef.current), [owner]);

  return (
    <WorkerPoolContext.Provider key={generation} value={pool}>
      <DiffWorkerThemeSync themeName={diffThemeName} />
      {workload > 0 && !pool ? null : children}
    </WorkerPoolContext.Provider>
  );
}
