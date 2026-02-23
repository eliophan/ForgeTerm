import { describe, expect, it } from "vitest";
import {
  countLeaves,
  createLeaf,
  findPathToId,
  removeAtPath,
  replaceLeaf,
} from "./tree";

describe("layout tree", () => {
  it("counts only leaf panes", () => {
    const node = {
      type: "split" as const,
      direction: "row" as const,
      ratio: 0.5,
      children: [createLeaf("pane-1"), createLeaf("pane-2")],
    };

    expect(countLeaves(node)).toBe(2);
  });

  it("replaces a placeholder with a live pane", () => {
    const root = {
      type: "placeholder" as const,
      id: "pane-1",
    };

    const next = replaceLeaf(root, "pane-1", createLeaf("pane-1"));
    expect(next).toEqual({ type: "leaf", id: "pane-1" });
  });

  it("removes one branch and focuses sibling", () => {
    const root = {
      type: "split" as const,
      direction: "column" as const,
      ratio: 0.5,
      children: [createLeaf("pane-1"), createLeaf("pane-2")],
    };

    const path = findPathToId(root, "pane-1");
    expect(path).toEqual([0]);
    const result = removeAtPath(root, path ?? []);

    expect(result.removed).toBe(true);
    expect(result.nextActiveId).toBe("pane-2");
    expect(result.node).toEqual({ type: "leaf", id: "pane-2" });
  });
});
