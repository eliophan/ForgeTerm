import { useCallback, useMemo, useState } from "react";
import type { SplitDirection } from "../types";
import type { LayoutNode } from "../types";
import { countLeaves, createLeaf, replaceLeaf, updateAtPath } from "../tree";

type UsePaneLayoutOptions = {
  maxPanes?: number;
};

export const usePaneLayout = ({
  maxPanes = 15,
}: UsePaneLayoutOptions) => {
  const [activeId, setActiveId] = useState("pane-1");
  const [layout, setLayout] = useState<LayoutNode>(() => createLeaf("pane-1"));

  const onFocus = useCallback((id: string) => {
    setActiveId(id);
  }, []);

  const activatePane = useCallback((id: string) => {
    setLayout((current) => replaceLeaf(current, id, createLeaf(id)));
    setActiveId(id);
  }, []);

  const paneCount = useMemo(() => countLeaves(layout), [layout]);
  const canCloseActive = paneCount > 1;

  const splitPaneAt = useCallback(
    (targetId: string, direction: SplitDirection) => {
      if (paneCount >= maxPanes) return;
      const newId = `pane-${Date.now().toString(36)}`;
      const next: LayoutNode = {
        type: "split",
        direction,
        ratio: 0.5,
        children: [createLeaf(targetId), createLeaf(newId)],
      };
      setLayout((current) => replaceLeaf(current, targetId, next));
    },
    [maxPanes, paneCount],
  );

  const onResizeSplit = useCallback((path: number[], ratio: number) => {
    setLayout((current) =>
      updateAtPath(current, path, (node) =>
        node.type === "split" ? { ...node, ratio } : node,
      ),
    );
  }, []);

  return {
    activeId,
    setActiveId,
    layout,
    setLayout,
    paneCount,
    maxPanes,
    canCloseActive,
    onFocus,
    activatePane,
    splitPaneAt,
    onResizeSplit,
  };
};
