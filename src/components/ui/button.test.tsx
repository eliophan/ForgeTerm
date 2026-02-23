import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Button } from "./button";

describe("Button", () => {
  it("renders children and handles clicks", () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Run</Button>);

    const button = screen.getByRole("button", { name: "Run" });
    button.click();

    expect(button).toBeInTheDocument();
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("applies icon size classes for icon variant", () => {
    render(<Button size="icon">+</Button>);
    expect(screen.getByRole("button", { name: "+" }).className).toContain("h-9");
  });
});
