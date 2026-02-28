import { useCallback, useMemo, useState } from "react";

// ── Tree data model ────────────────────────────────────────────────

export type LayoutLeaf = { type: "leaf"; paneId: string };
export type LayoutSplit = {
    type: "split";
    direction: "horizontal" | "vertical";
    first: LayoutNode;
    second: LayoutNode;
};
export type LayoutNode = LayoutLeaf | LayoutSplit;

// ── Helpers ────────────────────────────────────────────────────────

/** Collect all pane IDs from a tree in depth-first order. */
export function collectPaneIds(node: LayoutNode): string[] {
    if (node.type === "leaf") return [node.paneId];
    return [...collectPaneIds(node.first), ...collectPaneIds(node.second)];
}


/**
 * Replace the leaf with `targetId` with a split node that contains
 * the original leaf + a new leaf, in the given direction.
 * Returns [newTree, newPaneId] or null if the target wasn't found.
 */
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
            direction,
            first: { type: "leaf", paneId: targetId },
            second: { type: "leaf", paneId: newPaneId },
        };
    }

    // Try first branch
    const firstResult = splitAtLeaf(node.first, targetId, direction, newPaneId);
    if (firstResult) {
        return { ...node, first: firstResult };
    }

    // Try second branch
    const secondResult = splitAtLeaf(node.second, targetId, direction, newPaneId);
    if (secondResult) {
        return { ...node, second: secondResult };
    }

    return null;
}

/**
 * Remove a leaf from the tree and collapse the parent split to
 * its remaining child. Returns the new tree or null if not found.
 */
function removeLeaf(
    node: LayoutNode,
    targetId: string,
): LayoutNode | null {
    if (node.type === "leaf") {
        // Can't remove the root leaf from here — handled by the caller
        return null;
    }

    // If one of the direct children is the target leaf, return the other child
    if (node.first.type === "leaf" && node.first.paneId === targetId) {
        return node.second;
    }
    if (node.second.type === "leaf" && node.second.paneId === targetId) {
        return node.first;
    }

    // Recurse into first branch
    const firstResult = removeLeaf(node.first, targetId);
    if (firstResult) {
        return { ...node, first: firstResult };
    }

    // Recurse into second branch
    const secondResult = removeLeaf(node.second, targetId);
    if (secondResult) {
        return { ...node, second: secondResult };
    }

    return null;
}

// ── Hook ───────────────────────────────────────────────────────────

type UseLayoutTreeOptions = {
    maxPanes?: number;
};

export const useLayoutTree = ({
    maxPanes = 15,
}: UseLayoutTreeOptions = {}) => {
    const initialRoot: LayoutNode = { type: "leaf", paneId: "pane-1" };
    const [layoutRoot, setLayoutRoot] = useState<LayoutNode>(initialRoot);
    const [activeId, setActiveId] = useState("pane-1");

    const allPaneIds = useMemo(() => collectPaneIds(layoutRoot), [layoutRoot]);
    const paneCount = allPaneIds.length;
    const canCloseActive = paneCount > 1;

    const onFocus = useCallback((id: string) => {
        setActiveId(id);
    }, []);

    /**
     * Split the pane with `targetId` in the given direction.
     * Returns the new pane ID or null if maxPanes reached or target not found.
     */
    const splitPane = useCallback(
        (targetId: string, direction: "horizontal" | "vertical"): string | null => {
            if (paneCount >= maxPanes) return null;
            const newPaneId = `pane-${Date.now().toString(36)}`;
            setLayoutRoot((current) => {
                const result = splitAtLeaf(current, targetId, direction, newPaneId);
                return result ?? current;
            });
            return newPaneId;
        },
        [maxPanes, paneCount],
    );

    /**
     * Remove a pane from the tree. Returns true if removed.
     */
    const removePaneFromTree = useCallback(
        (targetId: string): boolean => {
            if (paneCount <= 1) return false;
            let removed = false;
            setLayoutRoot((current) => {
                const result = removeLeaf(current, targetId);
                if (result) {
                    removed = true;
                    return result;
                }
                return current;
            });
            return removed;
        },
        [paneCount],
    );

    /**
     * Get the neighbor pane id for focus fallback when closing a pane.
     */
    const getNeighborId = useCallback(
        (targetId: string): string | null => {
            const index = allPaneIds.indexOf(targetId);
            if (index === -1) return null;
            return allPaneIds[index + 1] ?? allPaneIds[index - 1] ?? null;
        },
        [allPaneIds],
    );

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
    };
};
