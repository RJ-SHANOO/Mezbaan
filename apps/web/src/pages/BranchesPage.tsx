import { useState, type FormEvent, type ReactElement } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Branch } from "@mezbaan/contracts";
import { apiRequest, ApiError } from "../lib/api-client.js";
import { useAuthStore } from "../lib/auth-store.js";
import { AppShell } from "../components/AppShell.js";
import { Card } from "../components/Card.js";
import { StatCard } from "../components/StatCard.js";
import { BuildingCountIcon, CheckCircleIcon, PauseCircleIcon } from "../components/icons.js";

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

  const branches = branchesQuery.data ?? [];
  const activeCount = branches.filter((b) => b.status === "active").length;
  const inactiveCount = branches.length - activeCount;

  return (
    <AppShell title="Branches">
      {branchesQuery.data && (
        <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
          <StatCard label="Total branches" value={branches.length} icon={<BuildingCountIcon className="h-5 w-5" />} tone="purple" />
          <StatCard label="Active" value={activeCount} icon={<CheckCircleIcon className="h-5 w-5" />} tone="green" />
          <StatCard label="Inactive" value={inactiveCount} icon={<PauseCircleIcon className="h-5 w-5" />} tone="amber" />
        </div>
      )}

      <Card title="Add a branch">
        <form onSubmit={handleCreate} className="flex flex-wrap items-end gap-3">
          <label className="space-y-1">
            <span className="block text-sm font-medium text-slate-700">Branch name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-brand-purple focus:outline-none focus:ring-1 focus:ring-brand-purple"
            />
          </label>
          <label className="space-y-1">
            <span className="block text-sm font-medium text-slate-700">Timezone</span>
            <input
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
              required
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-brand-purple focus:outline-none focus:ring-1 focus:ring-brand-purple"
            />
          </label>
          <button
            type="submit"
            disabled={createMutation.isPending}
            className="rounded-lg bg-brand-purple px-4 py-2 text-sm font-medium text-white transition hover:bg-brand-purple-dark disabled:opacity-50"
          >
            {createMutation.isPending ? "Adding…" : "Add branch"}
          </button>
        </form>
        {createMutation.isError && (
          <p className="mt-3 text-sm text-brand-red">
            {createMutation.error instanceof ApiError ? createMutation.error.message : "Couldn't add that branch."}
          </p>
        )}
      </Card>

      <div className="mt-6">
        {branchesQuery.isLoading && <p className="text-sm text-slate-500">Loading branches…</p>}
        {branchesQuery.isError && (
          <p className="text-sm text-brand-red">
            {branchesQuery.error instanceof ApiError ? branchesQuery.error.message : "Couldn't load branches."}
          </p>
        )}

        {branchesQuery.data && branches.length === 0 && (
          <Card>
            <p className="text-sm text-slate-500">No branches yet — add your first one above.</p>
          </Card>
        )}

        {branchesQuery.data && branches.length > 0 && (
          <Card>
            <ul className="-my-5 divide-y divide-slate-100">
              {branches.map((branch) => (
                <li key={branch.id} className="flex items-center justify-between gap-4 py-4 first:pt-0 last:pb-0">
                  <div>
                    <p className="font-medium text-slate-900">{branch.name}</p>
                    <p className="text-sm text-slate-500">{branch.timezone}</p>
                  </div>
                  <div className="flex items-center gap-3">
                    <span
                      className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                        branch.status === "active" ? "bg-brand-green/10 text-brand-green" : "bg-slate-100 text-slate-500"
                      }`}
                    >
                      {branch.status}
                    </span>
                    <button
                      type="button"
                      onClick={() => toggleStatusMutation.mutate(branch)}
                      disabled={toggleStatusMutation.isPending}
                      className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 transition hover:border-brand-purple hover:text-brand-purple disabled:opacity-50"
                    >
                      {branch.status === "active" ? "Deactivate" : "Activate"}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>
    </AppShell>
  );
}
