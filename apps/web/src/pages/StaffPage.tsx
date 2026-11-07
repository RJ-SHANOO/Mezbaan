import { useState, type FormEvent, type ReactElement } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { InvitableRoleKey, PendingInvitation, User } from "@mezbaan/contracts";
import { apiRequest, ApiError } from "../lib/api-client.js";
import { useAuthStore } from "../lib/auth-store.js";
import { AppShell } from "../components/AppShell.js";

const INVITABLE_ROLES: InvitableRoleKey[] = ["owner", "branch_manager", "cashier", "kitchen_staff"];

export function StaffPage(): ReactElement {
  const token = useAuthStore((state) => state.session?.accessToken ?? null);
  const queryClient = useQueryClient();

  const usersQuery = useQuery({
    queryKey: ["users"],
    queryFn: () => apiRequest<User[]>("/users", { token }),
    enabled: token !== null,
  });
  const invitationsQuery = useQuery({
    queryKey: ["user-invitations"],
    queryFn: () => apiRequest<PendingInvitation[]>("/users/invitations", { token }),
    enabled: token !== null,
  });

  const inviteMutation = useMutation({
    mutationFn: (body: { email: string; roleKey: InvitableRoleKey }) =>
      apiRequest<{ inviteToken: string }>("/users/invite", { method: "POST", body, token }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["user-invitations"] }),
  });

  const [email, setEmail] = useState("");
  const [roleKey, setRoleKey] = useState<InvitableRoleKey>("cashier");
  const [lastInviteLink, setLastInviteLink] = useState<string | null>(null);

  function handleInvite(event: FormEvent): void {
    event.preventDefault();
    setLastInviteLink(null);
    inviteMutation.mutate(
      { email, roleKey },
      {
        onSuccess: (result) => {
          setLastInviteLink(`${window.location.origin}/accept-invite?token=${result.inviteToken}`);
          setEmail("");
        },
      },
    );
  }

  return (
    <AppShell title="Staff">
      <form onSubmit={handleInvite} className="mb-6 flex flex-wrap items-end gap-3 rounded-lg border border-slate-200 bg-white p-4">
        <label className="space-y-1">
          <span className="block text-sm font-medium text-slate-700">Email</span>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            className="rounded border border-slate-300 px-3 py-2 text-sm"
          />
        </label>
        <label className="space-y-1">
          <span className="block text-sm font-medium text-slate-700">Role</span>
          <select
            value={roleKey}
            onChange={(e) => setRoleKey(e.target.value as InvitableRoleKey)}
            className="rounded border border-slate-300 px-3 py-2 text-sm"
          >
            {INVITABLE_ROLES.map((role) => (
              <option key={role} value={role}>
                {role}
              </option>
            ))}
          </select>
        </label>
        <button
          type="submit"
          disabled={inviteMutation.isPending}
          className="rounded bg-slate-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {inviteMutation.isPending ? "Sending…" : "Send invite"}
        </button>
      </form>
      {inviteMutation.isError && (
        <p className="mb-4 text-sm text-red-600">
          {inviteMutation.error instanceof ApiError ? inviteMutation.error.message : "Couldn't send that invite."}
        </p>
      )}
      {lastInviteLink && (
        <p className="mb-6 rounded border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
          No email provider is wired up yet — share this link with them directly:{" "}
          <span className="break-all font-mono text-xs">{lastInviteLink}</span>
        </p>
      )}

      <section className="mb-8">
        <h2 className="mb-2 text-sm font-semibold text-slate-700">Active staff</h2>
        {usersQuery.isLoading && <p className="text-sm text-slate-500">Loading staff…</p>}
        {usersQuery.isError && (
          <p className="text-sm text-red-600">{usersQuery.error instanceof ApiError ? usersQuery.error.message : "Couldn't load staff."}</p>
        )}
        {usersQuery.data && usersQuery.data.length === 0 && <p className="text-sm text-slate-500">No staff yet.</p>}
        {usersQuery.data && usersQuery.data.length > 0 && (
          <ul className="divide-y divide-slate-200 rounded-lg border border-slate-200 bg-white">
            {usersQuery.data.map((user) => (
              <li key={user.id} className="flex items-center justify-between p-4">
                <div>
                  <p className="font-medium text-slate-900">{user.displayName}</p>
                  <p className="text-sm text-slate-500">{user.email}</p>
                </div>
                <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">{user.roleKey}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold text-slate-700">Pending invitations</h2>
        {invitationsQuery.isLoading && <p className="text-sm text-slate-500">Loading invitations…</p>}
        {invitationsQuery.isError && (
          <p className="text-sm text-red-600">
            {invitationsQuery.error instanceof ApiError ? invitationsQuery.error.message : "Couldn't load invitations."}
          </p>
        )}
        {invitationsQuery.data && invitationsQuery.data.length === 0 && <p className="text-sm text-slate-500">No pending invitations.</p>}
        {invitationsQuery.data && invitationsQuery.data.length > 0 && (
          <ul className="divide-y divide-slate-200 rounded-lg border border-slate-200 bg-white">
            {invitationsQuery.data.map((invitation) => (
              <li key={invitation.id} className="flex items-center justify-between p-4">
                <p className="text-slate-900">{invitation.email}</p>
                <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700">{invitation.roleKey}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </AppShell>
  );
}
