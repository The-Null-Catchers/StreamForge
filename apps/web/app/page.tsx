"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Flame,
  Film,
  UploadCloud,
  ChartNoAxesCombined,
  KeyRound,
  Webhook,
  Settings,
  Search,
  LayoutGrid,
  List,
  Plus,
  ArrowUpRight,
  LogOut,
  Play,
  RefreshCw,
  X,
  FolderOpen,
  Check,
  Code2,
} from "lucide-react";
import { api, post, session, saveSession } from "../lib/api";
import { upload } from "../lib/upload";
import Player from "../components/Player";
type Video = {
  id: string;
  title: string;
  filename: string;
  status: string;
  privacy: string;
  size: string;
  created_at: string;
  metadata?: { width: number; height: number; duration: number; codec: string };
  progress: Record<string, number>;
  renditions: { name: string }[];
  error_code?: string;
  review_status?: "pending" | "approved" | "changes_requested";
  active_version_id?: string;
};
type Workspace = { id: string; name: string; role: string };
const size = (n: number) =>
  n > 1024 ** 3
    ? `${(n / 1024 ** 3).toFixed(1)} GB`
    : `${(n / 1024 ** 2).toFixed(1)} MB`;
const time = (n = 0) =>
  `${Math.floor(n / 60)}:${Math.floor(n % 60)
    .toString()
    .padStart(2, "0")}`;
export default function Dashboard() {
  const [authenticated, setAuthenticated] = useState(false);
  const [mode, setMode] = useState("login");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspace, setWorkspace] = useState("");
  const [videos, setVideos] = useState<Video[]>([]);
  const [view, setView] = useState("grid");
  const [section, setSection] = useState("library");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [offset, setOffset] = useState(0);
  useEffect(() => setOffset(0), [workspace, search, status]);
  const [selected, setSelected] = useState<Video | null>(null);
  const [usage, setUsage] = useState({
    source_bytes: 0,
    storage_limit: 1,
    videos: 0,
  });
  const [loading, setLoading] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [uploadState, setUploadState] = useState("");
  const [uploadPct, setUploadPct] = useState(0);
  const [speed, setSpeed] = useState(0);
  const [uploading, setUploading] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const [keys, setKeys] = useState<any[]>([]);
  const [hooks, setHooks] = useState<any[]>([]);
  const [analytics, setAnalytics] = useState<any>(null);
  const [notifications, setNotifications] = useState<any[]>([]);
  const [chapters, setChapters] = useState<any[]>([]);
  const [playlists, setPlaylists] = useState<any[]>([]);
  const [versions, setVersions] = useState<any[]>([]);
  const [reviewComments, setReviewComments] = useState<any[]>([]);
  useEffect(() => {
    setAuthenticated(!!session());
    const q = new URLSearchParams(location.search);
    if (q.has("verify")) {
      void post("/auth/verify", { token: q.get("verify") })
        .then(() => setNotice("Email verified. You can sign in."))
        .catch((e) => setNotice(e.message));
      history.replaceState({}, "", location.pathname);
    }
    if (q.has("reset")) setMode("reset");
  }, []);
  const loadWorkspaces = useCallback(async () => {
    try {
      const ws = await api<Workspace[]>("/workspaces");
      setWorkspaces(ws);
      setWorkspace((current) => current || ws[0]?.id || "");
    } catch (e) {
      setNotice((e as Error).message);
    }
  }, []);
  useEffect(() => {
    if (authenticated) void loadWorkspaces();
  }, [authenticated, loadWorkspaces]);
  const load = useCallback(async () => {
    if (!workspace) return;
    setLoading(true);
    try {
      const [v, u, n] = await Promise.all([
        api(
          `/videos?workspaceId=${workspace}&offset=${offset}&search=${encodeURIComponent(search)}${status ? `&status=${status}` : ""}`,
        ),
        api(`/workspaces/${workspace}/usage`),
        api(`/workspaces/${workspace}/notifications`),
      ]);
      setVideos(v.items);
      setUsage(u);
      setNotifications(n);
    } catch (e) {
      setNotice((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [workspace, search, status, offset]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (!workspace) return;
    const controller = new AbortController();
    let alive = true;
    void (async () => {
      while (alive) {
        try {
          const r = await fetch(`/api/v1/workspaces/${workspace}/events`, {
            headers: { Authorization: `Bearer ${session()}` },
            signal: controller.signal,
          });
          if (!r.ok) throw Error("reconnect");
          const reader = r.body!.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          while (alive) {
            const chunk = await reader.read();
            if (chunk.done) break;
            buffer += decoder.decode(chunk.value, { stream: true });
            const messages = buffer.split("\n\n");
            buffer = messages.pop() ?? "";
            for (const m of messages) {
              const line = m.split("\n").find((x) => x.startsWith("data: "));
              if (!line) continue;
              const changes = JSON.parse(line.slice(6));
              setVideos((old) =>
                old.map((v) => ({
                  ...v,
                  ...changes.find((x: any) => x.id === v.id),
                })),
              );
              setSelected((old) =>
                old
                  ? { ...old, ...changes.find((x: any) => x.id === old.id) }
                  : null,
              );
            }
          }
        } catch {
          if (alive) await load();
        }
        if (alive) await new Promise((r) => setTimeout(r, 3000));
      }
    })();
    return () => {
      alive = false;
      controller.abort();
    };
  }, [workspace, load]);
  useEffect(() => {
    if (selected?.status === "ready")
      void api(`/videos/${selected.id}/analytics`)
        .then(setAnalytics)
        .catch(() => {});
    else setAnalytics(null);
  }, [selected?.id, selected?.status]);
  useEffect(() => {
    if (!selected) {
      setChapters([]);
      return;
    }
    void api(`/videos/${selected.id}/chapters`)
      .then(setChapters)
      .catch((e) => setNotice(e.message));
  }, [selected?.id]);
  useEffect(() => {
    if (!selected) {
      setVersions([]);
      setReviewComments([]);
      return;
    }
    void Promise.all([
      api(`/videos/${selected.id}/versions`),
      api(`/videos/${selected.id}/review-comments`),
    ])
      .then(([versionRows, commentRows]) => {
        setVersions(versionRows);
        setReviewComments(commentRows);
      })
      .catch((e) => setNotice(e.message));
  }, [selected?.id]);
  useEffect(() => {
    if (!workspace) return;
    if (section === "keys")
      void api(`/api-keys?workspaceId=${workspace}`)
        .then(setKeys)
        .catch((e) => setNotice(e.message));
    if (section === "webhooks")
      void api(`/webhooks?workspaceId=${workspace}`)
        .then(setHooks)
        .catch((e) => setNotice(e.message));
    if (section === "playlists")
      void api(`/playlists?workspaceId=${workspace}`)
        .then(setPlaylists)
        .catch((e) => setNotice(e.message));
  }, [section, workspace]);
  async function authSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setNotice("");
    const form = new FormData(e.currentTarget);
    try {
      const email = form.get("email");
      const password = form.get("password");
      if (mode === "login") {
        saveSession(await post("/auth/login", { email, password }));
        setAuthenticated(true);
      } else if (mode === "register") {
        await post("/auth/register", { email, password });
        setNotice(
          "Check your email to verify your account. Local development: Mailpit on port 8025.",
        );
        setMode("login");
      } else if (mode === "forgot") {
        const r = await post("/auth/forgot", { email });
        setNotice(r.message);
      } else {
        await post("/auth/reset", {
          password,
          token: new URLSearchParams(location.search).get("reset"),
        });
        history.replaceState({}, "", location.pathname);
        setMode("login");
        setNotice("Password reset. Sign in with your new password.");
      }
    } catch (e) {
      setNotice((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function startUpload() {
    if (!file || !workspace) return;
    abort.current = new AbortController();
    setUploading(true);
    setNotice("");
    try {
      await upload(
        file,
        workspace,
        abort.current.signal,
        (bytes, bps) => {
          setUploadState("Uploading");
          setUploadPct(Math.round((bytes / file.size) * 100));
          setSpeed(bps);
        },
        (pct) => setUploadState(`Checking file integrity · ${pct}%`),
      );
      if (abort.current.signal.aborted)
        setUploadState("Paused. Select Resume to continue.");
      else {
        setUploadState("Upload complete. Processing has started.");
        setFile(null);
      }
      await load();
    } catch (e) {
      setUploadState("Interrupted. Resume to retry confirmed chunks.");
      setNotice((e as Error).message);
    } finally {
      setUploading(false);
    }
  }
  async function createWorkspace() {
    const name = prompt("Workspace name");
    if (!name) return;
    try {
      const w = await post("/workspaces", { name });
      await loadWorkspaces();
      setWorkspace(w.id);
    } catch (e) {
      setNotice((e as Error).message);
    }
  }
  if (!authenticated)
    return (
      <main className="auth">
        <div className="auth-story">
          <div className="brand">
            <Flame /> StreamForge
          </div>
          <span className="eyebrow">YOUR VIDEO. BUILT TO FLOW.</span>
          <h1>
            From raw footage
            <br />
            to a flawless
            <br />
            <em>first frame.</em>
          </h1>
          <p>
            Resumable uploads. Adaptive streaming. One reliable home for your
            media infrastructure.
          </p>
          <div className="flow">
            <UploadCloud />
            <span />
            <Film />
            <span />
            <Play />
          </div>
          <small>INGEST &nbsp; / &nbsp; PROCESS &nbsp; / &nbsp; DELIVER</small>
        </div>
        <section className="auth-form">
          <div className="eyebrow">WELCOME TO STREAMFORGE</div>
          <h2>
            {mode === "login"
              ? "Make something worth watching."
              : mode === "register"
                ? "Create your account."
                : mode === "forgot"
                  ? "Forgot your password?"
                  : "Set a new password."}
          </h2>
          <p>Your workspace is where every video begins.</p>
          {notice && (
            <div className="notice" role="status">
              {notice}
            </div>
          )}
          <form onSubmit={authSubmit}>
            {mode !== "reset" && (
              <label>
                Email address
                <input
                  type="email"
                  name="email"
                  placeholder="you@company.com"
                  required
                  autoComplete="email"
                />
              </label>
            )}
            {mode !== "forgot" && (
              <label>
                Password
                <input
                  type="password"
                  name="password"
                  minLength={12}
                  maxLength={128}
                  required
                  autoComplete={
                    mode === "login" ? "current-password" : "new-password"
                  }
                  placeholder="At least 12 characters"
                />
              </label>
            )}
            <button className="primary" disabled={busy}>
              {busy
                ? "Please wait…"
                : mode === "login"
                  ? "Sign in to your workspace"
                  : mode === "register"
                    ? "Create account"
                    : mode === "forgot"
                      ? "Send reset link"
                      : "Reset password"}
              <ArrowUpRight size={18} />
            </button>
          </form>
          <div className="auth-links">
            <button
              onClick={async () => {
                const email = prompt("Email address for verification");
                if (!email) return;
                try {
                  const result = await post("/auth/resend-verification", {
                    email,
                  });
                  setNotice(result.message);
                } catch (error) {
                  setNotice((error as Error).message);
                }
              }}
            >
              Resend verification
            </button>
            <button
              onClick={() =>
                setMode(mode === "register" ? "login" : "register")
              }
            >
              {mode === "register"
                ? "Already have an account? Sign in"
                : "Create an account"}
            </button>
            <button onClick={() => setMode("forgot")}>Forgot password?</button>
          </div>
        </section>
      </main>
    );
  return (
    <div className="shell">
      <aside className="sidebar">
        <a className="brand" href="/">
          <Flame /> StreamForge
        </a>
        <label className="workspace-label">
          WORKSPACE
          <select
            value={workspace}
            onChange={(e) => setWorkspace(e.target.value)}
            aria-label="Workspace"
          >
            {workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </label>
        <button className="new-workspace" onClick={createWorkspace}>
          <Plus size={14} /> New workspace
        </button>
        <div className="nav-caption">MANAGE</div>
        <nav>
          {[
            { id: "library", label: "Video library", icon: Film },
            { id: "activity", label: "Activity", icon: ChartNoAxesCombined },
            { id: "playlists", label: "Playlists", icon: FolderOpen },
            { id: "keys", label: "API keys", icon: KeyRound },
            { id: "webhooks", label: "Webhooks", icon: Webhook },
            { id: "settings", label: "Workspace", icon: Settings },
          ].map((item) => (
            <button
              key={item.id}
              className={section === item.id ? "active" : ""}
              onClick={() => {
                setSection(item.id);
                setSelected(null);
              }}
            >
              <item.icon size={18} />
              {item.label}
              {item.id === "library" && <b>{usage.videos}</b>}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="storage">
            <span>
              Source storage <small>{size(Number(usage.source_bytes))}</small>
            </span>
            <progress
              value={Number(usage.source_bytes)}
              max={Number(usage.storage_limit)}
            />
            <small>of {size(Number(usage.storage_limit))} reserved</small>
          </div>
          <button
            onClick={async () => {
              try {
                await post("/auth/logout", {});
              } finally {
                sessionStorage.clear();
                setAuthenticated(false);
              }
            }}
          >
            <LogOut size={16} /> Sign out
          </button>
        </div>
      </aside>
      <main className="main">
        <header className="topbar">
          <span>
            Workspace <span className="slash">/</span>{" "}
            <strong>
              {workspaces.find((w) => w.id === workspace)?.name ??
                "Get started"}
            </strong>
          </span>
          <span className="badge neutral">DEVELOPER PLATFORM</span>
        </header>
        <div className="content">
          {notice && (
            <div className="notice" role="alert">
              {notice}
              <button onClick={() => setNotice("")} aria-label="Dismiss">
                <X size={16} />
              </button>
            </div>
          )}
          {!workspace ? (
            <div className="empty">
              <FolderOpen size={40} />
              <h2>Create your first workspace</h2>
              <p>Keep your videos, team, and developer tools together.</p>
              <button className="primary" onClick={createWorkspace}>
                <Plus size={16} /> Create workspace
              </button>
            </div>
          ) : selected ? (
            <>
              <button
                className="back"
                onClick={() => {
                  setSelected(null);
                  void load();
                }}
              >
                ← Back to library
              </button>
              <div className="page-heading">
                <div>
                  <div className="eyebrow">VIDEO DETAILS</div>
                  <h1>{selected.title}</h1>
                </div>
                <span className={`badge ${selected.status}`}>
                  {selected.status}
                </span>
              </div>
              {selected.status === "ready" ? (
                <Player videoId={selected.id} />
              ) : (
                <div className="processing">
                  <RefreshCw
                    className={selected.status === "failed" ? "" : "spin"}
                  />
                  <h2>
                    {selected.status === "failed"
                      ? "Processing needs attention"
                      : "Your video is on its way"}
                  </h2>
                  <p>
                    {selected.error_code ??
                      "You can leave this page. Processing continues in the background."}
                  </p>
                  {Object.entries(selected.progress).map(([name, pct]) => (
                    <label key={name}>
                      {name} · {pct}%<progress max={100} value={pct} />
                    </label>
                  ))}
                  {selected.status === "failed" && (
                    <button
                      onClick={() =>
                        void post(`/videos/${selected.id}/retry`, {})
                          .then(load)
                          .catch((e) => setNotice(e.message))
                      }
                    >
                      Retry processing
                    </button>
                  )}
                </div>
              )}
              <div className="detail-grid">
                <section className="panel">
                  <h3>Asset information</h3>
                  <dl>
                    <dt>Playback ID</dt>
                    <dd>
                      <code>{selected.id}</code>
                    </dd>
                    <dt>Original file</dt>
                    <dd>{selected.filename}</dd>
                    <dt>Duration</dt>
                    <dd>{time(selected.metadata?.duration)}</dd>
                    <dt>Resolution</dt>
                    <dd>
                      {selected.metadata
                        ? `${selected.metadata.width} × ${selected.metadata.height}`
                        : "Analyzing"}
                    </dd>
                    <dt>Source size</dt>
                    <dd>{size(Number(selected.size))}</dd>
                    <dt>Privacy</dt>
                    <dd>{selected.privacy}</dd>
                  </dl>
                  <label>
                    Visibility
                    <select
                      value={selected.privacy}
                      onChange={async (e) => {
                        try {
                          await api(`/videos/${selected.id}`, {
                            method: "PATCH",
                            body: JSON.stringify({
                              title: selected.title,
                              privacy: e.target.value,
                            }),
                          });
                          setSelected({ ...selected, privacy: e.target.value });
                        } catch (err) {
                          setNotice((err as Error).message);
                        }
                      }}
                    >
                      {["private", "unlisted", "public"].map((p) => (
                        <option key={p}>{p}</option>
                      ))}
                    </select>
                  </label>
                </section>
                <section className="panel">
                  <h3>Playback analytics</h3>
                  {analytics ? (
                    <div className="analytics">
                      <div>
                        <strong>{analytics.plays}</strong>
                        <span>Plays</span>
                      </div>
                      <div>
                        <strong>{time(Number(analytics.watch_seconds))}</strong>
                        <span>Watch time</span>
                      </div>
                      <div>
                        <strong>{analytics.completions}</strong>
                        <span>Completions</span>
                      </div>
                      <div>
                        <strong>{analytics.playback_sessions}</strong>
                        <span>Playback sessions</span>
                      </div>
                    </div>
                  ) : (
                    <p>Analytics appear after your video is ready.</p>
                  )}
                  <button
                    onClick={async () => {
                      try {
                        const p = await api(`/videos/${selected.id}/playback`);
                        await navigator.clipboard.writeText(
                          `<iframe src="${p.embedUrl}" allow="autoplay; fullscreen; picture-in-picture" style="width:100%;aspect-ratio:16/9;border:0"></iframe>`,
                        );
                        setNotice(
                          "Embed copied. This signed link expires in one hour.",
                        );
                      } catch (e) {
                        setNotice((e as Error).message);
                      }
                    }}
                    disabled={selected.status !== "ready"}
                  >
                    <Code2 size={16} /> Copy secure embed
                  </button>
                </section>
              </div>
              <section className="panel">
                <h3>Subtitles</h3>
                <form
                  className="inline-form"
                  onSubmit={async (e) => {
                    e.preventDefault();
                    const f = new FormData(e.currentTarget);
                    const source = f.get("file") as File;
                    try {
                      await post(`/videos/${selected.id}/subtitles`, {
                        content: await source.text(),
                        language: f.get("language"),
                        label: f.get("label"),
                      });
                      setNotice(
                        "Subtitle track uploaded. Reopen the player to load it.",
                      );
                    } catch (err) {
                      setNotice((err as Error).message);
                    }
                  }}
                >
                  <input
                    name="language"
                    placeholder="Language code, e.g. ar"
                    required
                    pattern="[a-z]{2,3}(-[A-Za-z0-9]{2,8})?"
                  />
                  <input
                    name="label"
                    placeholder="Label, e.g. العربية"
                    required
                  />
                  <input name="file" type="file" accept=".srt,.vtt" required />
                  <button>Upload subtitles</button>
                </form>
              </section>
              <section className="panel">
                <h3>Chapters</h3>
                {chapters.length ? (
                  chapters.map((chapter, index) => (
                    <div className="resource-row" key={chapter.id ?? `${chapter.start_seconds}-${index}`}>
                      <div>
                        <strong>{time(Number(chapter.start_seconds))}</strong>
                        <p>{chapter.title}</p>
                      </div>
                      <button
                        onClick={async () => {
                          const next = chapters.filter((_, i) => i !== index);
                          try {
                            await api(`/videos/${selected.id}/chapters`, {
                              method: "PUT",
                              body: JSON.stringify({
                                chapters: next.map((item) => ({
                                  startSeconds: Number(item.start_seconds),
                                  title: item.title,
                                })),
                              }),
                            });
                            setChapters(next);
                          } catch (err) {
                            setNotice((err as Error).message);
                          }
                        }}
                      >
                        Remove
                      </button>
                    </div>
                  ))
                ) : (
                  <p>No chapters yet. Add timestamps to make long videos easier to navigate.</p>
                )}
                <form
                  className="inline-form"
                  onSubmit={async (e) => {
                    e.preventDefault();
                    const form = new FormData(e.currentTarget);
                    const startSeconds = Number(form.get("startSeconds"));
                    const title = String(form.get("title") ?? "").trim();
                    const next = [
                      ...chapters.map((item) => ({
                        start_seconds: Number(item.start_seconds),
                        title: item.title,
                      })),
                      { start_seconds: startSeconds, title },
                    ].sort((a, b) => a.start_seconds - b.start_seconds);
                    try {
                      await api(`/videos/${selected.id}/chapters`, {
                        method: "PUT",
                        body: JSON.stringify({
                          chapters: next.map((item) => ({
                            startSeconds: item.start_seconds,
                            title: item.title,
                          })),
                        }),
                      });
                      setChapters(next);
                      e.currentTarget.reset();
                    } catch (err) {
                      setNotice((err as Error).message);
                    }
                  }}
                >
                  <input
                    name="startSeconds"
                    type="number"
                    min="0"
                    step="0.1"
                    placeholder="Start (seconds)"
                    required
                  />
                  <input name="title" maxLength={200} placeholder="Chapter title" required />
                  <button>Add chapter</button>
                </form>
              </section>
              <section className="panel">
                <h3>Versions & review</h3>
                <div className="inline-form">
                  <label>
                    Review status
                    <select
                      value={selected.review_status ?? "pending"}
                      onChange={async (e) => {
                        const value = e.target.value as "pending" | "approved" | "changes_requested";
                        try {
                          await api(`/videos/${selected.id}/review-status`, {
                            method: "PUT",
                            body: JSON.stringify({ status: value }),
                          });
                          setSelected({ ...selected, review_status: value });
                        } catch (err) {
                          setNotice((err as Error).message);
                        }
                      }}
                    >
                      <option value="pending">Pending review</option>
                      <option value="approved">Approved</option>
                      <option value="changes_requested">Changes requested</option>
                    </select>
                  </label>
                </div>

                {versions.map((version) => (
                  <div className="resource-row" key={version.id}>
                    <div>
                      <strong>v{version.version_number} · {version.label}</strong>
                      <p>
                        {version.filename ?? "Processed asset"} · {size(Number(version.size))}
                        {version.active ? " · Active" : ""}
                      </p>
                    </div>
                    {!version.active && (
                      <button
                        onClick={async () => {
                          try {
                            await api(
                              `/videos/${selected.id}/versions/${version.id}/activate`,
                              { method: "PUT", body: JSON.stringify({}) },
                            );
                            const [detail, nextVersions] = await Promise.all([
                              api(`/videos/${selected.id}`),
                              api(`/videos/${selected.id}/versions`),
                            ]);
                            setSelected(detail);
                            setVersions(nextVersions);
                            setNotice(`Version ${version.version_number} is now active.`);
                          } catch (err) {
                            setNotice((err as Error).message);
                          }
                        }}
                      >
                        Make active
                      </button>
                    )}
                  </div>
                ))}

                <form
                  className="inline-form"
                  onSubmit={async (e) => {
                    e.preventDefault();
                    const form = new FormData(e.currentTarget);
                    try {
                      await post(`/videos/${selected.id}/versions`, {
                        sourceVideoId: form.get("sourceVideoId"),
                        label: form.get("label"),
                      });
                      setVersions(await api(`/videos/${selected.id}/versions`));
                      e.currentTarget.reset();
                    } catch (err) {
                      setNotice((err as Error).message);
                    }
                  }}
                >
                  <select name="sourceVideoId" required defaultValue="">
                    <option value="" disabled>
                      Choose a processed replacement video
                    </option>
                    {videos
                      .filter((video) => video.status === "ready" && video.id !== selected.id)
                      .map((video) => (
                        <option key={video.id} value={video.id}>
                          {video.title}
                        </option>
                      ))}
                  </select>
                  <input name="label" maxLength={200} placeholder="Version label, e.g. Client revision" />
                  <button>Add version</button>
                </form>

                <h3>Timestamped comments</h3>
                <form
                  className="inline-form"
                  onSubmit={async (e) => {
                    e.preventDefault();
                    const form = new FormData(e.currentTarget);
                    const timestampRaw = String(form.get("timestampSeconds") ?? "").trim();
                    try {
                      await post(`/videos/${selected.id}/review-comments`, {
                        timestampSeconds: timestampRaw ? Number(timestampRaw) : undefined,
                        body: form.get("body"),
                      });
                      setReviewComments(
                        await api(`/videos/${selected.id}/review-comments`),
                      );
                      e.currentTarget.reset();
                    } catch (err) {
                      setNotice((err as Error).message);
                    }
                  }}
                >
                  <input
                    name="timestampSeconds"
                    type="number"
                    min="0"
                    step="0.1"
                    placeholder="Timestamp seconds (optional)"
                  />
                  <input name="body" maxLength={5000} placeholder="Leave review feedback…" required />
                  <button>Add comment</button>
                </form>

                {reviewComments.length ? (
                  reviewComments.map((comment) => (
                    <div className="resource-row" key={comment.id}>
                      <div>
                        <strong>
                          {comment.timestamp_seconds == null
                            ? "General"
                            : time(Number(comment.timestamp_seconds))}
                          {" · "}
                          {comment.author_email}
                          {comment.parent_id ? " · Reply" : ""}
                          {comment.resolved_at ? " · Resolved" : ""}
                        </strong>
                        <p>{comment.body}</p>
                      </div>
                      <div>
                        <button
                          onClick={async () => {
                            const body = prompt("Reply");
                            if (!body) return;
                            try {
                              await post(`/videos/${selected.id}/review-comments`, {
                                versionId: comment.version_id ?? undefined,
                                parentId: comment.id,
                                timestampSeconds:
                                  comment.timestamp_seconds == null
                                    ? undefined
                                    : Number(comment.timestamp_seconds),
                                body,
                              });
                              setReviewComments(
                                await api(`/videos/${selected.id}/review-comments`),
                              );
                            } catch (err) {
                              setNotice((err as Error).message);
                            }
                          }}
                        >
                          Reply
                        </button>
                        <button
                          onClick={async () => {
                            try {
                              await api(
                                `/videos/${selected.id}/review-comments/${comment.id}`,
                                {
                                  method: "PATCH",
                                  body: JSON.stringify({
                                    resolved: !comment.resolved_at,
                                  }),
                                },
                              );
                              setReviewComments(
                                await api(`/videos/${selected.id}/review-comments`),
                              );
                            } catch (err) {
                              setNotice((err as Error).message);
                            }
                          }}
                        >
                          {comment.resolved_at ? "Reopen" : "Resolve"}
                        </button>
                      </div>
                    </div>
                  ))
                ) : (
                  <p>No review comments yet.</p>
                )}
              </section>
              <button
                className="danger"
                onClick={async () => {
                  if (!confirm("Delete this video and its media files?"))
                    return;
                  try {
                    await api(`/videos/${selected.id}`, { method: "DELETE" });
                    setSelected(null);
                    await load();
                  } catch (e) {
                    setNotice((e as Error).message);
                  }
                }}
              >
                Delete video
              </button>
            </>
          ) : section === "library" ? (
            <>
              <div className="page-heading">
                <div>
                  <div className="eyebrow">YOUR MEDIA, IN MOTION</div>
                  <h1>
                    Video library<span className="count">{usage.videos}</span>
                  </h1>
                  <p>
                    Upload once. Deliver an exceptional experience everywhere.
                  </p>
                </div>
                <button
                  className="primary"
                  onClick={() => input.current?.click()}
                >
                  <Plus size={18} /> Upload video
                </button>
              </div>
              <div className="stats">
                <div>
                  <span>Total videos</span>
                  <strong>{usage.videos}</strong>
                  <small>Your workspace library</small>
                </div>
                <div>
                  <span>Ready to stream</span>
                  <strong>
                    {videos.filter((v) => v.status === "ready").length}
                  </strong>
                  <small>In the current results</small>
                </div>
                <div>
                  <span>Processing</span>
                  <strong>
                    {
                      videos.filter((v) =>
                        [
                          "queued",
                          "probing",
                          "processing",
                          "packaging",
                        ].includes(v.status),
                      ).length
                    }
                  </strong>
                  <small>In the current results</small>
                </div>
                <div>
                  <span>Source storage</span>
                  <strong>{size(Number(usage.source_bytes))}</strong>
                  <small>Original media reserved</small>
                </div>
              </div>
              <input
                ref={input}
                type="file"
                accept="video/mp4,video/webm,video/quicktime,video/x-matroska"
                hidden
                onChange={(e) => {
                  setFile(e.target.files?.[0] ?? null);
                  setUploadPct(0);
                  setUploadState("Ready to upload");
                }}
              />
              {file || uploadState ? (
                <section className="upload-box">
                  <UploadCloud size={24} />
                  <div>
                    <strong>{file?.name ?? "Upload received"}</strong>
                    <p>
                      {uploadState}
                      {speed > 0 && uploading
                        ? ` · ${size(speed)}/s · ${Math.ceil((file!.size * (1 - uploadPct / 100)) / speed)}s remaining`
                        : ""}
                    </p>
                    <progress max={100} value={uploadPct} />
                  </div>
                  {file &&
                    (uploading ? (
                      <button onClick={() => abort.current?.abort()}>
                        Pause
                      </button>
                    ) : (
                      <button
                        className="primary"
                        onClick={() => void startUpload()}
                      >
                        Start / Resume
                      </button>
                    ))}
                </section>
              ) : (
                <button
                  className="dropzone"
                  onClick={() => input.current?.click()}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    setFile(e.dataTransfer.files[0] ?? null);
                    setUploadState("Ready to upload");
                  }}
                >
                  <div className="upload-symbol">
                    <UploadCloud size={25} />
                  </div>
                  <div>
                    <strong>Drop your next great video here</strong>
                    <p>
                      MP4, MOV, WebM, MKV · Resumable uploads with integrity
                      checks
                    </p>
                  </div>
                  <span>
                    Browse files <ArrowUpRight size={15} />
                  </span>
                </button>
              )}
              <div className="toolbar">
                <label className="search">
                  <Search size={17} />
                  <input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search your videos…"
                  />
                </label>
                <select
                  aria-label="Status filter"
                  value={status}
                  onChange={(e) => setStatus(e.target.value)}
                >
                  <option value="">All statuses</option>
                  {["ready", "processing", "queued", "uploading", "failed"].map(
                    (s) => (
                      <option key={s}>{s}</option>
                    ),
                  )}
                </select>
                <div className="view-toggle">
                  <button
                    aria-label="Grid view"
                    className={view === "grid" ? "chosen" : ""}
                    onClick={() => setView("grid")}
                  >
                    <LayoutGrid size={17} />
                  </button>
                  <button
                    aria-label="Table view"
                    className={view === "table" ? "chosen" : ""}
                    onClick={() => setView("table")}
                  >
                    <List size={18} />
                  </button>
                </div>
                <button aria-label="Refresh" onClick={() => void load()}>
                  <RefreshCw size={16} />
                </button>
              </div>
              {loading && !videos.length ? (
                <div className="video-grid">
                  {[1, 2, 3].map((n) => (
                    <div className="skeleton" key={n} />
                  ))}
                </div>
              ) : !videos.length ? (
                <div className="empty">
                  <Film size={36} />
                  <h2>
                    {search || status
                      ? "No matching videos"
                      : "Your library starts here"}
                  </h2>
                  <p>
                    {search || status
                      ? "Try a different search or status."
                      : "Upload a video to see metadata, renditions, and playback analytics."}
                  </p>
                </div>
              ) : view === "table" ? (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Video</th>
                        <th>Status</th>
                        <th>Duration</th>
                        <th>Size</th>
                        <th>Created</th>
                      </tr>
                    </thead>
                    <tbody>
                      {videos.map((v) => (
                        <tr key={v.id} onClick={() => setSelected(v)}>
                          <td>
                            <button>{v.title}</button>
                          </td>
                          <td>
                            <span className={`badge ${v.status}`}>
                              {v.status}
                            </span>
                          </td>
                          <td>{time(v.metadata?.duration)}</td>
                          <td>{size(Number(v.size))}</td>
                          <td>{new Date(v.created_at).toLocaleDateString()}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="video-grid">
                  {videos.map((v) => (
                    <button
                      className="video-card"
                      key={v.id}
                      onClick={() => setSelected(v)}
                    >
                      <VideoCover video={v} />
                      <div className="card-body">
                        <h3>{v.title}</h3>
                        <p>
                          {v.metadata
                            ? `${v.metadata.height}p · ${size(Number(v.size))}`
                            : size(Number(v.size))}
                          <span>{v.privacy}</span>
                        </p>
                        <div className="card-footer">
                          <span className={`badge ${v.status}`}>
                            {v.status === "ready" && <Check size={11} />}{" "}
                            {v.status}
                          </span>
                          <small>
                            {new Date(v.created_at).toLocaleDateString(
                              undefined,
                              { month: "short", day: "numeric" },
                            )}
                          </small>
                        </div>
                      </div>
                    </button>
                  ))}
                </div>
              )}
              <div className="pagination">
                <button
                  disabled={offset === 0 || loading}
                  onClick={() => setOffset((n) => Math.max(0, n - 30))}
                >
                  Previous
                </button>
                <span>Page {Math.floor(offset / 30) + 1}</span>
                <button
                  disabled={videos.length < 30 || loading}
                  onClick={() => setOffset((n) => n + 30)}
                >
                  Next
                </button>
              </div>
              <footer>
                Built for every frame.
                <span>StreamForge · Media infrastructure</span>
              </footer>
            </>
          ) : section === "playlists" ? (
            <>
              <div className="page-heading">
                <div>
                  <div className="eyebrow">ORGANIZE YOUR LIBRARY</div>
                  <h1>Playlists</h1>
                  <p>Create ordered collections for delivery, review, or curation.</p>
                </div>
              </div>
              <form
                className="panel inline-form"
                onSubmit={async (e) => {
                  e.preventDefault();
                  const form = new FormData(e.currentTarget);
                  try {
                    await post("/playlists", {
                      workspaceId: workspace,
                      name: form.get("name"),
                    });
                    setPlaylists(await api(`/playlists?workspaceId=${workspace}`));
                    e.currentTarget.reset();
                  } catch (err) {
                    setNotice((err as Error).message);
                  }
                }}
              >
                <input name="name" maxLength={200} placeholder="Playlist name" required />
                <button className="primary">Create playlist</button>
              </form>
              {playlists.length ? (
                playlists.map((playlist) => (
                  <div className="resource-row" key={playlist.id}>
                    <FolderOpen />
                    <div>
                      <strong>{playlist.name}</strong>
                      <p>{playlist.item_count} video{Number(playlist.item_count) === 1 ? "" : "s"}</p>
                    </div>
                    <button
                      onClick={async () => {
                        if (!confirm(`Delete playlist “${playlist.name}”? Videos will not be deleted.`))
                          return;
                        try {
                          await api(`/playlists/${playlist.id}`, { method: "DELETE" });
                          setPlaylists(await api(`/playlists?workspaceId=${workspace}`));
                        } catch (err) {
                          setNotice((err as Error).message);
                        }
                      }}
                    >
                      Delete
                    </button>
                  </div>
                ))
              ) : (
                <div className="empty">
                  <FolderOpen size={36} />
                  <h2>No playlists yet</h2>
                  <p>Create one here, then manage its ordered video IDs through the API or SDK.</p>
                </div>
              )}
            </>
          ) : section === "keys" ? (
            <>
              <div className="page-heading">
                <div>
                  <div className="eyebrow">DEVELOPER TOOLS</div>
                  <h1>API keys</h1>
                  <p>Scoped credentials for your server-side integrations.</p>
                </div>
              </div>
              <form
                className="panel inline-form"
                onSubmit={async (e) => {
                  e.preventDefault();
                  const f = new FormData(e.currentTarget);
                  try {
                    const r = await post("/api-keys", {
                      workspaceId: workspace,
                      name: f.get("name"),
                      scopes: f.getAll("scope"),
                    });
                    setNotice(
                      `Save this key now. It will only be shown once: ${r.key}`,
                    );
                    setKeys(await api(`/api-keys?workspaceId=${workspace}`));
                  } catch (err) {
                    setNotice((err as Error).message);
                  }
                }}
              >
                <input name="name" placeholder="Key name" required />
                {[
                  "videos:read",
                  "videos:write",
                  "uploads:write",
                  "analytics:read",
                ].map((s) => (
                  <label className="checkbox" key={s}>
                    <input
                      name="scope"
                      type="checkbox"
                      value={s}
                      defaultChecked
                    />
                    {s}
                  </label>
                ))}
                <button className="primary">Create key</button>
              </form>
              {keys.map((k) => (
                <div className="resource-row" key={k.id}>
                  <KeyRound />
                  <div>
                    <strong>{k.name}</strong>
                    <p>{k.scopes.join(" · ")}</p>
                  </div>
                  <button
                    disabled={!!k.revoked_at}
                    onClick={async () => {
                      if (!confirm("Revoke this API key?")) return;
                      await api(`/api-keys/${k.id}`, { method: "DELETE" });
                      setKeys(await api(`/api-keys?workspaceId=${workspace}`));
                    }}
                  >
                    {k.revoked_at ? "Revoked" : "Revoke"}
                  </button>
                </div>
              ))}
            </>
          ) : section === "webhooks" ? (
            <>
              <div className="page-heading">
                <div>
                  <div className="eyebrow">EVENT DELIVERY</div>
                  <h1>Webhooks</h1>
                  <p>Signed notifications when your media changes.</p>
                </div>
              </div>
              <form
                className="panel inline-form"
                onSubmit={async (e) => {
                  e.preventDefault();
                  try {
                    const r = await post("/webhooks", {
                      workspaceId: workspace,
                      url: new FormData(e.currentTarget).get("url"),
                    });
                    setNotice(
                      `Store your signing secret securely: ${r.secret}`,
                    );
                    setHooks(await api(`/webhooks?workspaceId=${workspace}`));
                  } catch (err) {
                    setNotice((err as Error).message);
                  }
                }}
              >
                <input
                  name="url"
                  type="url"
                  placeholder="https://your-service.com/webhooks"
                  required
                />
                <button className="primary">Add endpoint</button>
              </form>
              {hooks.map((h) => (
                <div className="resource-row" key={h.id}>
                  <Webhook />
                  <div>
                    <strong>{h.url}</strong>
                    <p>{h.enabled ? "Enabled" : "Disabled"}</p>
                  </div>
                  <button
                    onClick={async () => {
                      const d = await api(`/webhooks/${h.id}/deliveries`);
                      setNotice(
                        d.length
                          ? d
                              .map(
                                (x: any) =>
                                  `${x.event}: ${x.status} (${x.response_status ?? "pending"})`,
                              )
                              .join("\n")
                          : "No deliveries yet.",
                      );
                    }}
                  >
                    Delivery history
                  </button>
                </div>
              ))}
            </>
          ) : section === "activity" ? (
            <>
              <div className="page-heading">
                <div>
                  <div className="eyebrow">WORKSPACE UPDATES</div>
                  <h1>Activity</h1>
                </div>
              </div>
              {notifications.length ? (
                notifications.map((n) => (
                  <div className="resource-row" key={n.id}>
                    <Check />
                    <div>
                      <strong>{n.message}</strong>
                      <p>{new Date(n.created_at).toLocaleString()}</p>
                    </div>
                  </div>
                ))
              ) : (
                <div className="empty">
                  <ChartNoAxesCombined />
                  <h2>No activity yet</h2>
                  <p>Media processing updates will appear here.</p>
                </div>
              )}
            </>
          ) : (
            <>
              <div className="page-heading">
                <div>
                  <h1>Workspace settings</h1>
                  <p>Manage access with workspace-scoped roles.</p>
                </div>
              </div>
              <section className="panel">
                <h3>Invite a teammate</h3>
                <form
                  className="inline-form"
                  onSubmit={async (e) => {
                    e.preventDefault();
                    const f = new FormData(e.currentTarget);
                    try {
                      const r = await post(`/workspaces/${workspace}/invites`, {
                        email: f.get("email"),
                        role: f.get("role"),
                      });
                      setNotice(
                        `Invite token (valid 7 days). Share privately with your teammate: ${r.token}`,
                      );
                    } catch (err) {
                      setNotice((err as Error).message);
                    }
                  }}
                >
                  <input
                    name="email"
                    type="email"
                    placeholder="teammate@company.com"
                    required
                  />
                  <select name="role">
                    <option>viewer</option>
                    <option>editor</option>
                    <option>admin</option>
                  </select>
                  <button>Generate invite</button>
                </form>
                <h3>Accept an invitation</h3>
                <form
                  className="inline-form"
                  onSubmit={async (e) => {
                    e.preventDefault();
                    try {
                      await post("/invites/accept", {
                        token: new FormData(e.currentTarget).get("token"),
                      });
                      await loadWorkspaces();
                      setNotice("Invitation accepted.");
                    } catch (err) {
                      setNotice((err as Error).message);
                    }
                  }}
                >
                  <input name="token" placeholder="Invitation token" required />
                  <button>Join workspace</button>
                </form>
              </section>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
function VideoCover({ video }: { video: Video }) {
  const [poster, setPoster] = useState("");
  useEffect(() => {
    let active = true;
    if (video.status === "ready")
      void api(`/videos/${video.id}/playback`)
        .then((p) => {
          if (active) setPoster(p.poster);
        })
        .catch(() => {});
    return () => {
      active = false;
    };
  }, [video.id, video.status]);
  return (
    <div className="video-cover">
      {poster ? <img alt="" src={poster} /> : <Film size={38} />}
      <span className="video-duration">{time(video.metadata?.duration)}</span>
      {video.status === "ready" && (
        <span className="play-icon">
          <Play size={20} fill="currentColor" />
        </span>
      )}
    </div>
  );
}
