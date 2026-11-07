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
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ message: "Invalid email or password" }), { status: 401 })),
    );
    const error = await apiRequest("/auth/login").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).statusCode).toBe(401);
    expect((error as ApiError).message).toBe("Invalid email or password");
  });

  it("joins an array message (Zod validation errors) into one readable string", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ message: ["email: Invalid email", "password: Required"] }), { status: 400 })),
    );
    await expect(apiRequest("/auth/login")).rejects.toThrow("email: Invalid email, password: Required");
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

  it("sends the bearer token and JSON body when provided", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await apiRequest("/branches", { method: "POST", body: { name: "Main" }, token: "abc123" });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/branches");
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ name: "Main" }));
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer abc123");
  });

  it("omits the Authorization header when no token is given", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await apiRequest("/users/invite/accept", { method: "POST", body: {} });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });
});
