"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { api, session } from "../../lib/api";

type Workspace = { id: string; name: string; role: string };
type Invite = {
  id: string;
  email: string;
  role: "admin" | "editor" | "viewer";
  expires_at: string;
  expired: boolean;
};

export default function WorkspaceSettingsPage() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState("");
  const [invites, setInvites] = useState<Invite[]>([]);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const workspace = useMemo(
    () => workspaces.find((item) => item.id === workspaceId),
    [workspaces, workspaceId],
  );
  const canManageInvites = workspace?.role === "owner" || workspace?.role === "admin";
  const canRename = workspace?.role === "owner";

  async function loadInvites(id: string, role?: string) {
    if (!id || (role !== "owner" && role !== "admin")) {
      setInvites([]);
      return;
    }
    try {
      setInvites(await api<Invite[]>(`/workspaces/${id}/invites`));
    } catch (error) {
      setNotice((error as Error).message);
    }
  }

  async function loadWorkspaces(preferredId?: string) {
    const rows = await api<Workspace[]>("/workspaces");
    setWorkspaces(rows);
    const nextId =
      preferredId && rows.some((item) => item.id === preferredId)
        ? preferredId
        : rows[0]?.id ?? "";
    setWorkspaceId(nextId);
    const selected = rows.find((item) => item.id === nextId);
    await loadInvites(nextId, selected?.role);
  }

  useEffect(() => {
    if (!session()) {
      location.href = "/";
      return;
    }
    void loadWorkspaces().catch((error) => setNotice(error.message));
  }, []);

  useEffect(() => {
    if (!workspaceId) return;
    void loadInvites(workspaceId, workspace?.role);
  }, [workspaceId, workspace?.role]);

  async function renameWorkspace(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!workspaceId || !canRename) return;
    const form = new FormData(event.currentTarget);
    const name = String(form.get("name") ?? "").trim();
    if (!name) return;

    setBusy(true);
    setNotice("");
    try {
      await api(`/workspaces/${workspaceId}`, {
        method: "PATCH",
        body: JSON.stringify({ name }),
      });
      await loadWorkspaces(workspaceId);
      setNotice("Workspace name updated.");
    } catch (error) {
      setNotice((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function revokeInvite(inviteId: string) {
    if (!workspaceId || !canManageInvites) return;
    setBusy(true);
    setNotice("");
    try {
      await api(`/workspaces/${workspaceId}/invites/${inviteId}`, {
        method: "DELETE",
      });
      await loadInvites(workspaceId, workspace?.role);
      setNotice("Invitation revoked.");
    } catch (error) {
      setNotice((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="shell">
      <div className="topbar">
        <div>
          <strong>Workspace settings</strong>
          <p>Manage workspace identity and pending invitations.</p>
        </div>
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <Link href="/quotas">Quotas</Link>
          <Link href="/">Back to dashboard</Link>
        </div>
      </div>

      <section className="panel">
        <label>
          Workspace
          <select
            value={workspaceId}
            onChange={(event) => setWorkspaceId(event.target.value)}
          >
            {workspaces.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name} · {item.role}
              </option>
            ))}
          </select>
        </label>
        {notice && <p>{notice}</p>}
      </section>

      {workspace && (
        <section className="panel">
          <h2>Workspace identity</h2>
          <p>
            Rename the workspace without changing its ID, members, media, or API
            integrations.
          </p>
          <form className="settings-grid" onSubmit={renameWorkspace}>
            <label>
              Workspace name
              <input
                name="name"
                minLength={1}
                maxLength={100}
                defaultValue={workspace.name}
                disabled={!canRename || busy}
              />
            </label>
            <button className="primary" disabled={!canRename || busy}>
              Save workspace name
            </button>
          </form>
          {!canRename && <p>Only the workspace owner can rename this workspace.</p>}
        </section>
      )}

      <section className="panel">
        <h2>Pending invitations</h2>
        <p>
          Admins and owners can review and revoke invitations before they are
          accepted.
        </p>

        {!canManageInvites ? (
          <p>You need admin access to manage pending invitations.</p>
        ) : invites.length === 0 ? (
          <p>No pending invitations.</p>
        ) : (
          <div className="settings-grid">
            {invites.map((invite) => (
              <div className="resource-row" key={invite.id}>
                <div>
                  <strong>{invite.email}</strong>
                  <p>
                    {invite.role} · {invite.expired ? "Expired" : "Active until"} {" "}
                    {new Date(invite.expires_at).toLocaleString()}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => void revokeInvite(invite.id)}
                  disabled={busy}
                >
                  Revoke
                </button>
              </div>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}
