import { afterEach, describe, expect, it, vi } from "vitest";
import { apiRequest, ApiError } from "./api-client.js";

describe("apiRequest()", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the parsed JSON body on a successful response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 })));
    await expect(apiRequest<{ ok: boolean }>("/ping")).resolves.toEqual({ ok: true });
  });

  it("throws ApiError carrying the server's own message on a non-2xx response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ message: "Invalid or expired pairing code" }), { status: 401 })),
    );
    const error = await apiRequest("/devices/pair").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).statusCode).toBe(401);
    expect((error as ApiError).message).toBe("Invalid or expired pairing code");
  });

  it("falls back to a generic message when the error body has none", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 500 })));
    await expect(apiRequest("/anything")).rejects.toThrow("Something went wrong. Please try again.");
  });

  it("wraps a network failure (fetch itself rejecting) as an ApiError instead of leaking the raw error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    const error = await apiRequest("/ping").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).statusCode).toBe(0);
  });

  it("sends the X-Device-Token header (not Authorization) and the JSON body when provided", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await apiRequest("/devices/me", { method: "GET", deviceToken: "r1.abc123" });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/devices/me");
    const headers = init.headers as Record<string, string>;
    expect(headers["X-Device-Token"]).toBe("r1.abc123");
    expect(headers["Authorization"]).toBeUndefined();
  });

  it("omits the device-token header when none is given", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await apiRequest("/devices/pair", { method: "POST", body: { pairingCode: "x" } });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["X-Device-Token"]).toBeUndefined();
    expect(init.body).toBe(JSON.stringify({ pairingCode: "x" }));
  });
});
