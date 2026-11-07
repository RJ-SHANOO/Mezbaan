import { useState, type FormEvent, type ReactElement } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Branch } from "@mezbaan/contracts";
import { apiRequest, ApiError } from "../lib/api-client.js";
import { useAuthStore } from "../lib/auth-store.js";
import { AppShell } from "../components/AppShell.js";

export function BranchesPage(): ReactElement {
  const session = useAuthStore((state) => state.session);
  const token = session?.accessToken ?? null;
  const queryClient = useQueryClient();

  const branchesQuery = useQuery({
    queryKey: ["branches"],
    queryFn: () => apiRequest<Branch[]>("/branches", { token }),
    enabled: token !== null,
  });

  const createMutation = useMutation({
    mutationFn: (body: { name: string; timezone: string }) => apiRequest<Branch>("/branches", { method: "POST", body, token }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["branches"] }),
  });

  const toggleStatusMutation = useMutation({
    mutationFn: (branch: Branch) =>
      apiRequest<Branch>(`/branches/${branch.id}`, {
        method: "PATCH",
        body: { status: branch.status === "active" ? "inactive" : "active" },
        token,
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["branches"] }),
  });

  const [name, setName] = useState("");
  const [timezone, setTimezone] = useState("Asia/Karachi");

  function handleCreate(event: FormEvent): void {
    event.preventDefault();
    createMutation.mutate({ name, timezone }, { onSuccess: () => setName("") });
  }

  return (
    <AppShell title="Branches">
      <form onSubmit={handleCreate} className="mb-6 flex flex-wrap items-end gap-3 rounded-lg border border-slate-200 bg-white p-4">
        <label className="space-y-1">
          <span className="block text-sm font-medium text-slate-700">Branch name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            className="rounded border border-slate-300 px-3 py-2 text-sm"
          />
        </label>
        <label className="space-y-1">
          <span className="block text-sm font-medium text-slate-700">Timezone</span>
          <input
            value={timezone}
            onChange={(e) => setTimezone(e.target.value)}
            required
            className="rounded border border-slate-300 px-3 py-2 text-sm"
          />
        </label>
        <button
          type="submit"
          disabled={createMutation.isPending}
          className="rounded bg-slate-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {createMutation.isPending ? "Adding…" : "Add branch"}
        </button>
      </form>
      {createMutation.isError && (
        <p className="mb-4 text-sm text-red-600">
          {createMutation.error instanceof ApiError ? createMutation.error.message : "Couldn't add that branch."}
        </p>
      )}

      {branchesQuery.isLoading && <p className="text-sm text-slate-500">Loading branches…</p>}
      {branchesQuery.isError && (
        <p className="text-sm text-red-600">
          {branchesQuery.error instanceof ApiError ? branchesQuery.error.message : "Couldn't load branches."}
        </p>
      )}
      {branchesQuery.data && branchesQuery.data.length === 0 && (
        <p className="text-sm text-slate-500">No branches yet — add your first one above.</p>
      )}

      {branchesQuery.data && branchesQuery.data.length > 0 && (
        <ul className="divide-y divide-slate-200 rounded-lg border border-slate-200 bg-white">
          {branchesQuery.data.map((branch) => (
            <li key={branch.id} className="flex items-center justify-between gap-4 p-4">
              <div>
                <p className="font-medium text-slate-900">{branch.name}</p>
                <p className="text-sm text-slate-500">{branch.timezone}</p>
              </div>
              <div className="flex items-center gap-3">
                <span
                  className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                    branch.status === "active" ? "bg-green-100 text-green-700" : "bg-slate-100 text-slate-500"
                  }`}
                >
                  {branch.status}
                </span>
                <button
                  type="button"
                  onClick={() => toggleStatusMutation.mutate(branch)}
                  disabled={toggleStatusMutation.isPending}
                  className="rounded border border-slate-300 px-2 py-1 text-xs font-medium text-slate-700 disabled:opacity-50"
                >
                  {branch.status === "active" ? "Deactivate" : "Activate"}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </AppShell>
  );
}
