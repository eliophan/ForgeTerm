export type ImeMode = "buffered" | "native";

const IME_MODE_KEY = "terminal:ime-mode";

export const getImeMode = (): ImeMode => {
  if (typeof window === "undefined") return "buffered";
  try {
    const stored = window.localStorage.getItem(IME_MODE_KEY);
    return stored === "native" ? "native" : "buffered";
  } catch {
    return "buffered";
  }
};

export const setImeMode = (mode: ImeMode) => {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(IME_MODE_KEY, mode);
  } catch {
    // Ignore storage failures (private mode, etc.)
  }
};
