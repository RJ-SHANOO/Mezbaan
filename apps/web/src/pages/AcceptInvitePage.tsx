import { useState, type FormEvent, type ReactElement } from "react";
import { apiRequest, ApiError } from "../lib/api-client.js";
import { CheckCircleIcon } from "../components/icons.js";
import { navigate, useRoute } from "../lib/router.js";

export function AcceptInvitePage(): ReactElement {
  const { searchParams } = useRoute();
  const inviteToken = searchParams.get("token") ?? "";
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [accepted, setAccepted] = useState(false);

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);
    try {
      await apiRequest("/users/invite/accept", { method: "POST", body: { inviteToken, displayName, password } });
      setAccepted(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  }

  if (!inviteToken) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-[#efeafb] via-slate-50 to-[#e4fbfb] px-4">
        <p className="text-sm text-brand-red">This invitation link is missing its token.</p>
      </div>
    );
  }

  if (accepted) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-[#efeafb] via-slate-50 to-[#e4fbfb] px-4">
        <div className="w-full max-w-sm space-y-4 rounded-xl border border-slate-100 bg-white p-7 text-center shadow-sm">
          <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-brand-green/10 text-brand-green">
            <CheckCircleIcon className="h-6 w-6" />
          </span>
          <p className="font-medium text-slate-900">Your account is ready.</p>
          <button type="button" onClick={() => navigate("/login")} className="text-sm font-medium text-brand-purple hover:underline">
            Go to sign in
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-[#efeafb] via-slate-50 to-[#e4fbfb] px-4">
      <form onSubmit={handleSubmit} className="w-full max-w-sm space-y-4 rounded-xl border border-slate-100 bg-white p-7 shadow-sm">
        <div className="mb-2 flex items-center gap-2">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-purple text-base font-bold text-white">M</span>
          <span className="text-lg font-bold text-brand-purple">Mezbaan</span>
        </div>
        <h1 className="text-sm font-medium text-slate-500">Set up your account</h1>

        <label className="block space-y-1">
          <span className="text-sm font-medium text-slate-700">Your name</span>
          <input
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            required
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-brand-purple focus:outline-none focus:ring-1 focus:ring-brand-purple"
          />
        </label>

        <label className="block space-y-1">
          <span className="text-sm font-medium text-slate-700">Password</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={8}
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-brand-purple focus:outline-none focus:ring-1 focus:ring-brand-purple"
          />
        </label>

        {error && <p className="text-sm text-brand-red">{error}</p>}

        <button
          type="submit"
          disabled={isSubmitting}
          className="w-full rounded-lg bg-brand-purple px-3 py-2.5 text-sm font-medium text-white transition hover:bg-brand-purple-dark disabled:opacity-50"
        >
          {isSubmitting ? "Creating account…" : "Create account"}
        </button>
      </form>
    </div>
  );
}
