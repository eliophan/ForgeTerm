export type SplitDirection = "row" | "column";

export type LayoutNode =
  | { type: "leaf"; id: string }
  | { type: "placeholder"; id: string }
  | {
      type: "split";
      direction: SplitDirection;
      ratio: number;
      children: [LayoutNode, LayoutNode];
    };
