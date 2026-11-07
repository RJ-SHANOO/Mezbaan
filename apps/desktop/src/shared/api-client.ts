const API_POS_BASE_URL = import.meta.env.VITE_API_POS_URL ?? "http://localhost:3001";

export class ApiError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

interface ApiRequestOptions {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  /** The device's own token (X-Device-Token, not Authorization — see
   * DeviceAuthGuard's doc comment in packages/nest-core for why). */
  deviceToken?: string | null;
}

/** Same reference pattern as apps/web's api-client.ts, pointed at api-pos instead
 * of api-admin — the desktop app talks to the POS/sync API, never the admin one. */
export async function apiRequest<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_POS_BASE_URL}${path}`, {
      method: options.method ?? "GET",
      headers: {
        "Content-Type": "application/json",
        ...(options.deviceToken ? { "X-Device-Token": options.deviceToken } : {}),
      },
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
  } catch {
    throw new ApiError(0, "Couldn't reach the server. Check your connection and try again.");
  }

  const data: unknown = await response.json().catch(() => undefined);

  if (!response.ok) {
    throw new ApiError(response.status, extractErrorMessage(data));
  }
  return data as T;
}

function extractErrorMessage(data: unknown): string {
  if (typeof data === "object" && data !== null && "message" in data) {
    const message = (data as { message: unknown }).message;
    if (typeof message === "string") return message;
    if (Array.isArray(message)) return message.join(", ");
  }
  return "Something went wrong. Please try again.";
}
