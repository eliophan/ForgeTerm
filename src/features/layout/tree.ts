import type { LayoutNode } from "./types";

export const createLeaf = (id: string): LayoutNode => ({ type: "leaf", id });

export const createPlaceholder = (id: string): LayoutNode => ({
  type: "placeholder",
  id,
});

export const replaceLeaf = (
  node: LayoutNode,
  targetId: string,
  next: LayoutNode,
): LayoutNode => {
  if (node.type === "leaf") {
    return node.id === targetId ? next : node;
  }
  if (node.type === "placeholder") {
    return node.id === targetId ? next : node;
  }
  return {
    ...node,
    children: [
      replaceLeaf(node.children[0], targetId, next),
      replaceLeaf(node.children[1], targetId, next),
    ],
  };
};

export const updateAtPath = (
  node: LayoutNode,
  path: number[],
  updater: (node: LayoutNode) => LayoutNode,
): LayoutNode => {
  if (path.length === 0) return updater(node);
  if (node.type !== "split") return node;
  const [index, ...rest] = path;
  const nextChildren = node.children.map((child, i) =>
    i === index ? updateAtPath(child, rest, updater) : child,
  ) as [LayoutNode, LayoutNode];
  return { ...node, children: nextChildren };
};

export const countLeaves = (node: LayoutNode): number => {
  if (node.type === "leaf") return 1;
  if (node.type === "placeholder") return 0;
  return countLeaves(node.children[0]) + countLeaves(node.children[1]);
};

export const findPathToId = (
  node: LayoutNode,
  targetId: string,
  path: number[] = [],
): number[] | null => {
  if (node.type === "leaf" || node.type === "placeholder") {
    return node.id === targetId ? path : null;
  }
  const left = findPathToId(node.children[0], targetId, [...path, 0]);
  if (left) return left;
  return findPathToId(node.children[1], targetId, [...path, 1]);
};

const findFirstLeafId = (node: LayoutNode): string | null => {
  if (node.type === "leaf") return node.id;
  if (node.type !== "split") return null;
  return findFirstLeafId(node.children[0]) ?? findFirstLeafId(node.children[1]);
};

const findFirstPlaceholderId = (node: LayoutNode): string | null => {
  if (node.type === "placeholder") return node.id;
  if (node.type !== "split") return null;
  return (
    findFirstPlaceholderId(node.children[0]) ??
    findFirstPlaceholderId(node.children[1])
  );
};

export const findFirstFocusableId = (node: LayoutNode): string | null =>
  findFirstLeafId(node) ?? findFirstPlaceholderId(node);

export const removeAtPath = (
  node: LayoutNode,
  path: number[],
): { node: LayoutNode; nextActiveId: string | null; removed: boolean } => {
  if (path.length === 0) {
    return { node, nextActiveId: null, removed: false };
  }
  if (node.type !== "split") {
    return { node, nextActiveId: null, removed: false };
  }
  const [index, ...rest] = path;
  if (rest.length === 0) {
    const siblingIndex = index === 0 ? 1 : 0;
    const sibling = node.children[siblingIndex];
    return { node: sibling, nextActiveId: findFirstFocusableId(sibling), removed: true };
  }

  const updated = removeAtPath(node.children[index], rest);
  if (!updated.removed) {
    return { node, nextActiveId: null, removed: false };
  }

  const nextChildren = node.children.map((child, i) =>
    i === index ? updated.node : child,
  ) as [LayoutNode, LayoutNode];
  const nextNode: LayoutNode = { ...node, children: nextChildren };

  if (
    nextNode.type === "split" &&
    nextNode.children[0].type === "placeholder" &&
    nextNode.children[1].type === "placeholder"
  ) {
    const collapsed = nextNode.children[0];
    return {
      node: collapsed,
      nextActiveId: findFirstFocusableId(collapsed),
      removed: true,
    };
  }

  return { node: nextNode, nextActiveId: updated.nextActiveId, removed: true };
};
