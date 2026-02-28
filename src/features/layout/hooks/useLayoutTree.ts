import { useCallback, useMemo, useState } from "react";

// ── Tree data model ────────────────────────────────────────────────

export type LayoutLeaf = { type: "leaf"; paneId: string };
export type LayoutSplit = {
    type: "split";
    id: string;
    direction: "horizontal" | "vertical";
    ratio: number; // 0–1, fraction for the first child
    first: LayoutNode;
    second: LayoutNode;
};
export type LayoutNode = LayoutLeaf | LayoutSplit;

// ── Bounds computation ─────────────────────────────────────────────

export type PaneBounds = {
    top: number;   // 0–1 fraction
    left: number;  // 0–1 fraction
    width: number; // 0–1 fraction
    height: number; // 0–1 fraction
};

export type HandleInfo = {
    splitId: string;
    direction: "horizontal" | "vertical";
    /** Position of the divider line (fraction 0–1 of the container) */
    pos: number;
    /** Bounds of the split region (for clamping when dragging) */
    splitBounds: PaneBounds;
};

/** Walk the tree and compute absolute bounds + handle positions. */
export function computeLayout(
    node: LayoutNode,
    bounds: PaneBounds,
    paneMap: Map<string, PaneBounds>,
    handles: HandleInfo[],
): void {
    if (node.type === "leaf") {
        paneMap.set(node.paneId, bounds);
        return;
    }

    const { direction, ratio, first, second, id } = node;

    if (direction === "horizontal") {
        const firstW = bounds.width * ratio;
        const secondW = bounds.width * (1 - ratio);
        computeLayout(
            first,
            { top: bounds.top, left: bounds.left, width: firstW, height: bounds.height },
            paneMap,
            handles,
        );
        computeLayout(
            second,
            { top: bounds.top, left: bounds.left + firstW, width: secondW, height: bounds.height },
            paneMap,
            handles,
        );
        handles.push({
            splitId: id,
            direction: "horizontal",
            pos: bounds.left + firstW,
            splitBounds: bounds,
        });
    } else {
        const firstH = bounds.height * ratio;
        const secondH = bounds.height * (1 - ratio);
        computeLayout(
            first,
            { top: bounds.top, left: bounds.left, width: bounds.width, height: firstH },
            paneMap,
            handles,
        );
        computeLayout(
            second,
            { top: bounds.top + firstH, left: bounds.left, width: bounds.width, height: secondH },
            paneMap,
            handles,
        );
        handles.push({
            splitId: id,
            direction: "vertical",
            pos: bounds.top + firstH,
            splitBounds: bounds,
        });
    }
}

// ── Tree helpers ───────────────────────────────────────────────────

/** Collect all pane IDs from a tree in depth-first order. */
export function collectPaneIds(node: LayoutNode): string[] {
    if (node.type === "leaf") return [node.paneId];
    return [...collectPaneIds(node.first), ...collectPaneIds(node.second)];
}

let splitCounter = 0;
function nextSplitId(): string {
    return `split-${++splitCounter}`;
}

function splitAtLeaf(
    node: LayoutNode,
    targetId: string,
    direction: "horizontal" | "vertical",
    newPaneId: string,
): LayoutNode | null {
    if (node.type === "leaf") {
        if (node.paneId !== targetId) return null;
        return {
            type: "split",
            id: nextSplitId(),
            direction,
            ratio: 0.5,
            first: { type: "leaf", paneId: targetId },
            second: { type: "leaf", paneId: newPaneId },
        };
    }

    const firstResult = splitAtLeaf(node.first, targetId, direction, newPaneId);
    if (firstResult) return { ...node, first: firstResult };

    const secondResult = splitAtLeaf(node.second, targetId, direction, newPaneId);
    if (secondResult) return { ...node, second: secondResult };

    return null;
}

function removeLeaf(node: LayoutNode, targetId: string): LayoutNode | null {
    if (node.type === "leaf") return null;
    if (node.first.type === "leaf" && node.first.paneId === targetId) return node.second;
    if (node.second.type === "leaf" && node.second.paneId === targetId) return node.first;

    const firstResult = removeLeaf(node.first, targetId);
    if (firstResult) return { ...node, first: firstResult };

    const secondResult = removeLeaf(node.second, targetId);
    if (secondResult) return { ...node, second: secondResult };

    return null;
}

function updateRatio(node: LayoutNode, splitId: string, newRatio: number): LayoutNode {
    if (node.type === "leaf") return node;
    if (node.id === splitId) return { ...node, ratio: newRatio };
    const first = updateRatio(node.first, splitId, newRatio);
    const second = updateRatio(node.second, splitId, newRatio);
    if (first === node.first && second === node.second) return node;
    return { ...node, first, second };
}

// ── Hook ───────────────────────────────────────────────────────────

type UseLayoutTreeOptions = { maxPanes?: number };

export const useLayoutTree = ({ maxPanes = 15 }: UseLayoutTreeOptions = {}) => {
    const initialRoot: LayoutNode = { type: "leaf", paneId: "pane-1" };
    const [layoutRoot, setLayoutRoot] = useState<LayoutNode>(initialRoot);
    const [activeId, setActiveId] = useState("pane-1");

    const allPaneIds = useMemo(() => collectPaneIds(layoutRoot), [layoutRoot]);
    const paneCount = allPaneIds.length;
    const canCloseActive = paneCount > 1;

    const onFocus = useCallback((id: string) => setActiveId(id), []);

    const splitPane = useCallback(
        (targetId: string, direction: "horizontal" | "vertical"): string | null => {
            if (paneCount >= maxPanes) return null;
            const newPaneId = `pane-${Date.now().toString(36)}`;
            setLayoutRoot((cur) => splitAtLeaf(cur, targetId, direction, newPaneId) ?? cur);
            return newPaneId;
        },
        [maxPanes, paneCount],
    );

    const removePaneFromTree = useCallback(
        (targetId: string): boolean => {
            if (paneCount <= 1) return false;
            let removed = false;
            setLayoutRoot((cur) => {
                const result = removeLeaf(cur, targetId);
                if (result) { removed = true; return result; }
                return cur;
            });
            return removed;
        },
        [paneCount],
    );

    const getNeighborId = useCallback(
        (targetId: string): string | null => {
            const idx = allPaneIds.indexOf(targetId);
            if (idx === -1) return null;
            return allPaneIds[idx + 1] ?? allPaneIds[idx - 1] ?? null;
        },
        [allPaneIds],
    );

    const setSplitRatio = useCallback(
        (splitId: string, newRatio: number) => {
            const clamped = Math.max(0.1, Math.min(0.9, newRatio));
            setLayoutRoot((cur) => updateRatio(cur, splitId, clamped));
        },
        [],
    );

    // Computed layout: pane bounds + handles
    const { paneBoundsMap, handles } = useMemo(() => {
        const paneMap = new Map<string, PaneBounds>();
        const h: HandleInfo[] = [];
        computeLayout(layoutRoot, { top: 0, left: 0, width: 1, height: 1 }, paneMap, h);
        return { paneBoundsMap: paneMap, handles: h };
    }, [layoutRoot]);

    return {
        layoutRoot,
        setLayoutRoot,
        activeId,
        setActiveId,
        allPaneIds,
        paneCount,
        maxPanes,
        canCloseActive,
        onFocus,
        splitPane,
        removePaneFromTree,
        getNeighborId,
        setSplitRatio,
        paneBoundsMap,
        handles,
    };
};
