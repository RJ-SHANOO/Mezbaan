// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { navigate } from "./router.js";

afterEach(() => {
  window.history.pushState({}, "", "/");
});

describe("navigate()", () => {
  it("pushes the new path onto history", () => {
    navigate("/branches");
    expect(window.location.pathname).toBe("/branches");
  });

  it("dispatches a popstate event so listeners (useRoute) pick up the change", () => {
    let firedPath: string | null = null;
    const handler = (): void => {
      firedPath = window.location.pathname;
    };
    window.addEventListener("popstate", handler);

    navigate("/staff");

    window.removeEventListener("popstate", handler);
    expect(firedPath).toBe("/staff");
  });
});
