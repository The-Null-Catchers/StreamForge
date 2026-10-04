"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { api, session } from "../../lib/api";

type Workspace = { id: string; name: string; role: string };
type Video = {
  id: string;
  title: string;
  filename?: string;
  status: string;
  privacy: string;
  size: string;
  created_at: string;
  metadata?: { width?: number; height?: number; duration?: number; codec?: string };
};
type Filters = {
  search: string;
  status: string;
  privacy: string;
  createdAfter: string;
  createdBefore: string;
  minDuration: string;
  maxDuration: string;
  minHeight: string;
  maxHeight: string;
  sort: "latest" | "oldest" | "duration" | "size";
};
type Preset = { name: string; filters: Filters };

const emptyFilters: Filters = {
  search: "",
  status: "",
  privacy: "",
  createdAfter: "",
  createdBefore: "",
  minDuration: "",
  maxDuration: "",
  minHeight: "",
  maxHeight: "",
  sort: "latest",
};

function isoDate(value: string, endOfDay = false) {
  if (!value) return "";
  return new Date(`${value}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z`).toISOString();
}

function formatDuration(seconds = 0) {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

function formatBytes(bytes: string) {
  const n = Number(bytes || 0);
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  return `${(n / 1024 ** 2).toFixed(1)} MB`;
}

export default function LibraryPage() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState("");
  const [filters, setFilters] = useState<Filters>(emptyFilters);
  const [videos, setVideos] = useState<Video[]>([]);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState("");
  const [presets, setPresets] = useState<Preset[]>([]);
  const [presetName, setPresetName] = useState("");

  useEffect(() => {
    if (!session()) {
      location.href = "/";
      return;
    }
    void api<Workspace[]>("/workspaces")
      .then((rows) => {
        setWorkspaces(rows);
        setWorkspaceId(rows[0]?.id ?? "");
      })
      .catch((error) => setNotice((error as Error).message));
  }, []);

  useEffect(() => {
    if (!workspaceId) return;
    try {
      const stored = JSON.parse(localStorage.getItem(`sf_library_presets_${workspaceId}`) ?? "[]");
      setPresets(Array.isArray(stored) ? stored : []);
    } catch {
      setPresets([]);
    }
  }, [workspaceId]);

  useEffect(() => setOffset(0), [workspaceId, filters]);

  const query = useMemo(() => {
    const params = new URLSearchParams({
      workspaceId,
      offset: String(offset),
      limit: "30",
      sort: filters.sort,
    });
    if (filters.search) params.set("search", filters.search);
    if (filters.status) params.set("status", filters.status);
    if (filters.privacy) params.set("privacy", filters.privacy);
    if (filters.createdAfter) params.set("createdAfter", isoDate(filters.createdAfter));
    if (filters.createdBefore) params.set("createdBefore", isoDate(filters.createdBefore, true));
    if (filters.minDuration) params.set("minDuration", filters.minDuration);
    if (filters.maxDuration) params.set("maxDuration", filters.maxDuration);
    if (filters.minHeight) params.set("minHeight", filters.minHeight);
    if (filters.maxHeight) params.set("maxHeight", filters.maxHeight);
    return params.toString();
  }, [workspaceId, offset, filters]);

  useEffect(() => {
    if (!workspaceId) return;
    const timer = setTimeout(() => {
      setLoading(true);
      setNotice("");
      void api<{ items: Video[] }>(`/videos?${query}`)
        .then((response) => setVideos(response.items))
        .catch((error) => setNotice((error as Error).message))
        .finally(() => setLoading(false));
    }, 180);
    return () => clearTimeout(timer);
  }, [workspaceId, query]);

  function update<K extends keyof Filters>(key: K, value: Filters[K]) {
    setFilters((current) => ({ ...current, [key]: value }));
  }

  function savePreset() {
    const name = presetName.trim();
    if (!name || !workspaceId) return;
    const next = [
      ...presets.filter((preset) => preset.name.toLowerCase() !== name.toLowerCase()),
      { name, filters },
    ].slice(-12);
    setPresets(next);
    localStorage.setItem(`sf_library_presets_${workspaceId}`, JSON.stringify(next));
    setPresetName("");
  }

  function deletePreset(name: string) {
    const next = presets.filter((preset) => preset.name !== name);
    setPresets(next);
    localStorage.setItem(`sf_library_presets_${workspaceId}`, JSON.stringify(next));
  }

  return (
    <main className="shell">
      <div className="topbar">
        <div>
          <strong>Advanced library</strong>
          <p>Filter, sort and save reusable views across your media catalog.</p>
        </div>
        <Link href="/">Back to dashboard</Link>
      </div>

      <section className="panel">
        <div className="settings-grid">
          <label>
            Workspace
            <select value={workspaceId} onChange={(event) => setWorkspaceId(event.target.value)}>
              {workspaces.map((workspace) => (
                <option key={workspace.id} value={workspace.id}>{workspace.name}</option>
              ))}
            </select>
          </label>
          <label>
            Search
            <input value={filters.search} onChange={(event) => update("search", event.target.value)} placeholder="Title, filename, tags…" />
          </label>
          <label>
            Status
            <select value={filters.status} onChange={(event) => update("status", event.target.value)}>
              <option value="">All statuses</option>
              {['draft','uploading','uploaded','probing','queued','processing','packaging','ready','failed'].map((status) => <option key={status}>{status}</option>)}
            </select>
          </label>
          <label>
            Privacy
            <select value={filters.privacy} onChange={(event) => update("privacy", event.target.value)}>
              <option value="">All privacy levels</option>
              <option value="private">Private</option>
              <option value="unlisted">Unlisted</option>
              <option value="public">Public</option>
            </select>
          </label>
          <label>
            Created after
            <input type="date" value={filters.createdAfter} onChange={(event) => update("createdAfter", event.target.value)} />
          </label>
          <label>
            Created before
            <input type="date" value={filters.createdBefore} onChange={(event) => update("createdBefore", event.target.value)} />
          </label>
          <label>
            Minimum duration (seconds)
            <input type="number" min="0" max="86400" value={filters.minDuration} onChange={(event) => update("minDuration", event.target.value)} />
          </label>
          <label>
            Maximum duration (seconds)
            <input type="number" min="0" max="86400" value={filters.maxDuration} onChange={(event) => update("maxDuration", event.target.value)} />
          </label>
          <label>
            Minimum height (px)
            <input type="number" min="1" max="8192" value={filters.minHeight} onChange={(event) => update("minHeight", event.target.value)} />
          </label>
          <label>
            Maximum height (px)
            <input type="number" min="1" max="8192" value={filters.maxHeight} onChange={(event) => update("maxHeight", event.target.value)} />
          </label>
          <label>
            Sort
            <select value={filters.sort} onChange={(event) => update("sort", event.target.value as Filters["sort"])}>
              <option value="latest">Newest first</option>
              <option value="oldest">Oldest first</option>
              <option value="duration">Longest duration</option>
              <option value="size">Largest size</option>
            </select>
          </label>
        </div>

        <div className="upload-actions">
          <button onClick={() => setFilters(emptyFilters)}>Clear filters</button>
          <input value={presetName} onChange={(event) => setPresetName(event.target.value)} placeholder="Preset name" aria-label="Preset name" />
          <button className="primary" onClick={savePreset} disabled={!presetName.trim()}>Save preset</button>
        </div>

        {presets.length > 0 && (
          <div className="upload-actions">
            {presets.map((preset) => (
              <span key={preset.name} className="badge">
                <button onClick={() => setFilters(preset.filters)}>{preset.name}</button>
                <button aria-label={`Delete preset ${preset.name}`} onClick={() => deletePreset(preset.name)}>×</button>
              </span>
            ))}
          </div>
        )}
      </section>

      {notice && <p className="notice">{notice}</p>}

      <section className="panel">
        <div className="topbar">
          <div>
            <strong>{loading ? "Loading…" : `${videos.length} videos on this page`}</strong>
            <p>Filters are evaluated by the API against durable metadata.</p>
          </div>
          <div className="upload-actions">
            <button disabled={offset === 0 || loading} onClick={() => setOffset(Math.max(0, offset - 30))}>Previous</button>
            <button disabled={videos.length < 30 || loading} onClick={() => setOffset(offset + 30)}>Next</button>
          </div>
        </div>

        <div className="library-grid">
          {videos.map((video) => (
            <article className="video-card" key={video.id}>
              <div>
                <strong>{video.title}</strong>
                <p>{video.filename || "No filename"}</p>
              </div>
              <div className="video-meta">
                <span>{video.status}</span>
                <span>{video.privacy}</span>
                <span>{video.metadata?.height ? `${video.metadata.height}p` : "—"}</span>
                <span>{video.metadata?.duration ? formatDuration(video.metadata.duration) : "—"}</span>
                <span>{formatBytes(video.size)}</span>
                <span>{new Date(video.created_at).toLocaleDateString()}</span>
              </div>
            </article>
          ))}
          {!loading && videos.length === 0 && <p>No videos match the current filters.</p>}
        </div>
      </section>
    </main>
  );
}
