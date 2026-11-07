import { useState, type FormEvent, type ReactElement, type ReactNode } from "react";
import type { LoginResponse } from "@mezbaan/contracts";
import { apiRequest, ApiError } from "../lib/api-client.js";
import { useAuthStore } from "../lib/auth-store.js";
import { navigate } from "../lib/router.js";

export function LoginPage(): ReactElement {
  const setSession = useAuthStore((state) => state.setSession);
  const [restaurantSlug, setRestaurantSlug] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);
    try {
      const response = await apiRequest<LoginResponse>("/auth/login", {
        method: "POST",
        body: { restaurantSlug, email, password },
      });
      setSession({ accessToken: response.accessToken, refreshToken: response.refreshToken, restaurantSlug });
      navigate("/branches");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-[#efeafb] via-slate-50 to-[#e4fbfb] px-4">
      <form onSubmit={handleSubmit} className="w-full max-w-sm space-y-4 rounded-xl border border-slate-100 bg-white p-7 shadow-sm">
        <div className="mb-2 flex items-center gap-2">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-purple text-base font-bold text-white">M</span>
          <span className="text-lg font-bold text-brand-purple">Mezbaan</span>
        </div>
        <h1 className="text-sm font-medium text-slate-500">Sign in to your restaurant</h1>

        <Field label="Restaurant URL">
          <input
            value={restaurantSlug}
            onChange={(e) => setRestaurantSlug(e.target.value)}
            placeholder="your-restaurant"
            required
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-brand-purple focus:outline-none focus:ring-1 focus:ring-brand-purple"
          />
        </Field>

        <Field label="Email">
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-brand-purple focus:outline-none focus:ring-1 focus:ring-brand-purple"
          />
        </Field>

        <Field label="Password">
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-brand-purple focus:outline-none focus:ring-1 focus:ring-brand-purple"
          />
        </Field>

        {error && <p className="text-sm text-brand-red">{error}</p>}

        <button
          type="submit"
          disabled={isSubmitting}
          className="w-full rounded-lg bg-brand-purple px-3 py-2.5 text-sm font-medium text-white transition hover:bg-brand-purple-dark disabled:opacity-50"
        >
          {isSubmitting ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }): ReactElement {
  return (
    <label className="block space-y-1">
      <span className="text-sm font-medium text-slate-700">{label}</span>
      {children}
    </label>
  );
}
