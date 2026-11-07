import { useState, type FormEvent, type ReactElement } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { InvitableRoleKey, PendingInvitation, User } from "@mezbaan/contracts";
import { apiRequest, ApiError } from "../lib/api-client.js";
import { useAuthStore } from "../lib/auth-store.js";
import { AppShell } from "../components/AppShell.js";
import { Card } from "../components/Card.js";
import { StatCard } from "../components/StatCard.js";
import { ClockIcon, MailIcon, UsersIcon } from "../components/icons.js";

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
      {(usersQuery.data ?? invitationsQuery.data) && (
        <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
          <StatCard label="Active staff" value={usersQuery.data?.length ?? "—"} icon={<UsersIcon className="h-5 w-5" />} tone="purple" />
          <StatCard
            label="Pending invitations"
            value={invitationsQuery.data?.length ?? "—"}
            icon={<ClockIcon className="h-5 w-5" />}
            tone="amber"
          />
        </div>
      )}

      <Card title="Invite a staff member">
        <form onSubmit={handleInvite} className="flex flex-wrap items-end gap-3">
          <label className="space-y-1">
            <span className="block text-sm font-medium text-slate-700">Email</span>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-brand-purple focus:outline-none focus:ring-1 focus:ring-brand-purple"
            />
          </label>
          <label className="space-y-1">
            <span className="block text-sm font-medium text-slate-700">Role</span>
            <select
              value={roleKey}
              onChange={(e) => setRoleKey(e.target.value as InvitableRoleKey)}
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-brand-purple focus:outline-none focus:ring-1 focus:ring-brand-purple"
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
            className="rounded-lg bg-brand-teal px-4 py-2 text-sm font-medium text-white transition hover:brightness-95 disabled:opacity-50"
          >
            {inviteMutation.isPending ? "Sending…" : "Send invite"}
          </button>
        </form>
        {inviteMutation.isError && (
          <p className="mt-3 text-sm text-brand-red">
            {inviteMutation.error instanceof ApiError ? inviteMutation.error.message : "Couldn't send that invite."}
          </p>
        )}
        {lastInviteLink && (
          <p className="mt-4 flex items-start gap-2 rounded-lg bg-brand-teal/10 p-3 text-sm text-slate-700">
            <MailIcon className="mt-0.5 h-4 w-4 shrink-0 text-brand-teal" />
            <span>
              No email provider is wired up yet — share this link with them directly:{" "}
              <span className="break-all font-mono text-xs">{lastInviteLink}</span>
            </span>
          </p>
        )}
      </Card>

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card title="Active staff">
          {usersQuery.isLoading && <p className="text-sm text-slate-500">Loading staff…</p>}
          {usersQuery.isError && (
            <p className="text-sm text-brand-red">{usersQuery.error instanceof ApiError ? usersQuery.error.message : "Couldn't load staff."}</p>
          )}
          {usersQuery.data && usersQuery.data.length === 0 && <p className="text-sm text-slate-500">No staff yet.</p>}
          {usersQuery.data && usersQuery.data.length > 0 && (
            <ul className="-my-4 divide-y divide-slate-100">
              {usersQuery.data.map((user) => (
                <li key={user.id} className="flex items-center justify-between gap-4 py-4 first:pt-0 last:pb-0">
                  <div>
                    <p className="font-medium text-slate-900">{user.displayName}</p>
                    <p className="text-sm text-slate-500">{user.email}</p>
                  </div>
                  <span className="rounded-full bg-brand-purple/10 px-2.5 py-0.5 text-xs font-semibold text-brand-purple">{user.roleKey}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Pending invitations">
          {invitationsQuery.isLoading && <p className="text-sm text-slate-500">Loading invitations…</p>}
          {invitationsQuery.isError && (
            <p className="text-sm text-brand-red">
              {invitationsQuery.error instanceof ApiError ? invitationsQuery.error.message : "Couldn't load invitations."}
            </p>
          )}
          {invitationsQuery.data && invitationsQuery.data.length === 0 && <p className="text-sm text-slate-500">No pending invitations.</p>}
          {invitationsQuery.data && invitationsQuery.data.length > 0 && (
            <ul className="-my-4 divide-y divide-slate-100">
              {invitationsQuery.data.map((invitation) => (
                <li key={invitation.id} className="flex items-center justify-between gap-4 py-4 first:pt-0 last:pb-0">
                  <p className="text-slate-900">{invitation.email}</p>
                  <span className="rounded-full bg-brand-amber/15 px-2.5 py-0.5 text-xs font-semibold text-brand-amber">{invitation.roleKey}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </AppShell>
  );
}
