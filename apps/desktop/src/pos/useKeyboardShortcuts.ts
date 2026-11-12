import { useEffect, useRef } from "react";

export interface KeyboardShortcutHandlers {
  categoryCount: number;
  onSelectCategoryByIndex: (index: number) => void;
  onFocusSearch: () => void;
  onClearSearch: () => void;
}

/**
 * P2-11: digits 1-9 jump to that category (only up to however many exist),
 * "/" focuses the search box, Escape clears it. Digit/"/" shortcuts are
 * suppressed while an input or textarea already has focus, so they never
 * fight with someone actually typing a product name or a quantity — Escape
 * still works from inside the search box, since clearing it is exactly what
 * you'd want mid-typing.
 */
export function useKeyboardShortcuts(handlers: KeyboardShortcutHandlers): void {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent): void {
      const target = event.target;
      const isTyping = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;

      if (event.key === "Escape") {
        handlersRef.current.onClearSearch();
        return;
      }
      if (isTyping) return;

      if (event.key === "/") {
        event.preventDefault();
        handlersRef.current.onFocusSearch();
        return;
      }

      const digit = Number(event.key);
      if (Number.isInteger(digit) && digit >= 1 && digit <= 9 && digit <= handlersRef.current.categoryCount) {
        handlersRef.current.onSelectCategoryByIndex(digit - 1);
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);
}
