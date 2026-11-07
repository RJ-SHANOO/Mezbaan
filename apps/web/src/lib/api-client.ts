const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:3002";

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
  token?: string | null;
}

/** The one place every screen talks to the API through — later modules copying this
 * reference pattern should add their calls here (or a sibling file), not inline
 * `fetch()` calls in components. Throws ApiError with the server's own message on
 * any non-2xx response, so callers can show it directly instead of a generic
 * "something went wrong". */
export async function apiRequest<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      method: options.method ?? "GET",
      headers: {
        "Content-Type": "application/json",
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
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
