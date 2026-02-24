import { useCallback, useMemo, useState } from "react";

type UsePaneListOptions = {
  maxPanes?: number;
};

export const usePaneList = ({
  maxPanes = 15,
}: UsePaneListOptions) => {
  const [activeId, setActiveId] = useState("pane-1");
  const [panes, setPanes] = useState<string[]>(["pane-1"]);

  const paneCount = panes.length;
  const canCloseActive = paneCount > 1;

  const addPane = useCallback((afterId?: string) => {
    if (paneCount >= maxPanes) return null;
    const newId = `pane-${Date.now().toString(36)}`;
    setPanes((current) => {
      if (!afterId) return [...current, newId];
      const index = current.indexOf(afterId);
      if (index === -1) return [...current, newId];
      const next = [...current];
      next.splice(index + 1, 0, newId);
      return next;
    });
    return newId;
  }, [maxPanes, paneCount]);

  const removePane = useCallback((id: string) => {
    setPanes((current) => current.filter((paneId) => paneId !== id));
  }, []);

  const onFocus = useCallback((id: string) => {
    setActiveId(id);
  }, []);

  const activatePane = useCallback((id: string) => {
    setActiveId(id);
  }, []);

  const orderIndexById = useMemo(() => {
    const map = new Map<string, number>();
    panes.forEach((paneId, index) => map.set(paneId, index));
    return map;
  }, [panes]);

  return {
    activeId,
    setActiveId,
    panes,
    setPanes,
    paneCount,
    maxPanes,
    canCloseActive,
    onFocus,
    activatePane,
    addPane,
    removePane,
    orderIndexById,
  };
};
