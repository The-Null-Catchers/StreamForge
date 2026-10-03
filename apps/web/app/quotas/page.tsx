"use client";

import { FormEvent, useEffect, useState } from "react";
import Link from "next/link";
import { api, session } from "../../lib/api";

type Workspace = { id: string; name: string; role: string };
type Usage = {
  storage_limit: number | string;
  video_limit: number | string;
  upload_bytes_monthly_limit: number | string;
  output_storage_limit: number | string;
  processing_seconds_monthly_limit: number | string;
  live_concurrency_limit: number | string;
  live_minutes_monthly_limit: number | string;
  source_bytes: number | string;
  videos: number | string;
  upload_bytes_this_month: number | string;
  output_bytes: number | string;
  processing_seconds_this_month: number | string;
  active_live_streams: number | string;
  live_seconds_this_month: number | string;
};

const gb = (bytes: number | string) => Number(bytes) / 1024 ** 3;
const toBytes = (value: FormDataEntryValue | null) =>
  Math.round(Number(value ?? 0) * 1024 ** 3);
const pct = (used: number | string, limit: number | string) => {
  const max = Number(limit);
  if (!max) return Number(used) > 0 ? 100 : 0;
  return Math.min(100, Math.round((Number(used) / max) * 100));
};

export default function QuotaSettingsPage() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState("");
  const [usage, setUsage] = useState<Usage | null>(null);
  const [notice, setNotice] = useState("");
  const workspace = workspaces.find((item) => item.id === workspaceId);

  async function loadUsage(id: string) {
    if (!id) return;
    try {
      setUsage(await api(`/workspaces/${id}/usage`));
    } catch (error) {
      setNotice((error as Error).message);
    }
  }

  useEffect(() => {
    if (!session()) {
      location.href = "/";
      return;
    }
    void api<Workspace[]>("/workspaces")
      .then((rows) => {
        setWorkspaces(rows);
        const first = rows[0]?.id ?? "";
        setWorkspaceId(first);
        return loadUsage(first);
      })
      .catch((error) => setNotice(error.message));
  }, []);

  useEffect(() => {
    void loadUsage(workspaceId);
  }, [workspaceId]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!workspaceId || workspace?.role !== "owner") return;
    const form = new FormData(event.currentTarget);
    try {
      await api(`/workspaces/${workspaceId}/quotas`, {
        method: "PUT",
        body: JSON.stringify({
          storageLimit: toBytes(form.get("sourceStorageGb")),
          videoLimit: Number(form.get("videoLimit")),
          uploadBytesMonthlyLimit: toBytes(form.get("monthlyUploadGb")),
          outputStorageLimit: toBytes(form.get("outputStorageGb")),
          processingSecondsMonthlyLimit: Math.round(
            Number(form.get("processingHours")) * 3600,
          ),
          liveConcurrencyLimit: Number(form.get("liveConcurrency")),
          liveMinutesMonthlyLimit: Number(form.get("liveMinutes")),
        }),
      });
      await loadUsage(workspaceId);
      setNotice("Quota limits saved.");
    } catch (error) {
      setNotice((error as Error).message);
    }
  }

  return (
    <main className="shell">
      <div className="topbar">
        <div>
          <strong>StreamForge quotas</strong>
          <p>Workspace capacity, monthly limits, and warning thresholds.</p>
        </div>
        <Link href="/">Back to dashboard</Link>
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

      {usage && (
        <>
          <section className="panel">
            <h2>Current usage</h2>
            {[
              ["Source storage", usage.source_bytes, usage.storage_limit],
              ["Videos", usage.videos, usage.video_limit],
              [
                "Monthly uploads",
                usage.upload_bytes_this_month,
                usage.upload_bytes_monthly_limit,
              ],
              ["Output storage", usage.output_bytes, usage.output_storage_limit],
              [
                "Processing compute",
                usage.processing_seconds_this_month,
                usage.processing_seconds_monthly_limit,
              ],
              [
                "Live minutes",
                Number(usage.live_seconds_this_month) / 60,
                usage.live_minutes_monthly_limit,
              ],
            ].map(([label, used, limit]) => (
              <div className="resource-row" key={String(label)}>
                <div>
                  <strong>{String(label)}</strong>
                  <p>{pct(used, limit)}% used</p>
                </div>
                <progress value={Number(used)} max={Math.max(1, Number(limit))} />
              </div>
            ))}
          </section>

          <section className="panel">
            <h2>Quota administration</h2>
            <p>
              Owners can change self-hosted workspace caps. Lowering a limit
              below current usage does not delete data; it blocks new work until
              usage falls below the limit.
            </p>
            <form className="settings-grid" onSubmit={save}>
              <label>
                Source storage (GB)
                <input
                  name="sourceStorageGb"
                  type="number"
                  min="0"
                  step="0.1"
                  defaultValue={gb(usage.storage_limit).toFixed(1)}
                />
              </label>
              <label>
                Video count
                <input
                  name="videoLimit"
                  type="number"
                  min="0"
                  defaultValue={Number(usage.video_limit)}
                />
              </label>
              <label>
                Monthly uploads (GB)
                <input
                  name="monthlyUploadGb"
                  type="number"
                  min="0"
                  step="0.1"
                  defaultValue={gb(usage.upload_bytes_monthly_limit).toFixed(1)}
                />
              </label>
              <label>
                Output storage (GB)
                <input
                  name="outputStorageGb"
                  type="number"
                  min="0"
                  step="0.1"
                  defaultValue={gb(usage.output_storage_limit).toFixed(1)}
                />
              </label>
              <label>
                Processing compute (hours/month)
                <input
                  name="processingHours"
                  type="number"
                  min="0"
                  step="0.1"
                  defaultValue={(
                    Number(usage.processing_seconds_monthly_limit) / 3600
                  ).toFixed(1)}
                />
              </label>
              <label>
                Concurrent live streams
                <input
                  name="liveConcurrency"
                  type="number"
                  min="0"
                  defaultValue={Number(usage.live_concurrency_limit)}
                />
              </label>
              <label>
                Live minutes/month
                <input
                  name="liveMinutes"
                  type="number"
                  min="0"
                  defaultValue={Number(usage.live_minutes_monthly_limit)}
                />
              </label>
              <button className="primary" disabled={workspace?.role !== "owner"}>
                Save quota limits
              </button>
            </form>
            {workspace?.role !== "owner" && (
              <p>Only the workspace owner can change quota limits.</p>
            )}
          </section>
        </>
      )}
    </main>
  );
}
