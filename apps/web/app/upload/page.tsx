"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
  upload,
  uploadDirect,
  type TranscodingProfile,
  type UploadMode,
} from "../../lib/upload";
import { api, session } from "../../lib/api";

type Workspace = { id: string; name: string; role: string };
type Profile = {
  id: TranscodingProfile;
  label: string;
  description: string;
  maxHeight: number;
  bitrateMultiplier: number;
};

function formatRate(bytesPerSecond: number) {
  if (!bytesPerSecond) return "";
  if (bytesPerSecond >= 1024 ** 2)
    return `${(bytesPerSecond / 1024 ** 2).toFixed(1)} MiB/s`;
  return `${(bytesPerSecond / 1024).toFixed(0)} KiB/s`;
}

export default function UploadPage() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState("");
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [profile, setProfile] = useState<TranscodingProfile>("balanced");
  const [mode, setMode] = useState<UploadMode>("direct");
  const [file, setFile] = useState<File | null>(null);
  const [state, setState] = useState("");
  const [speed, setSpeed] = useState("");
  const [pct, setPct] = useState(0);
  const [uploading, setUploading] = useState(false);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!session()) {
      location.href = "/";
      return;
    }
    void Promise.all([
      api<Workspace[]>("/workspaces"),
      api<Profile[]>("/transcoding-profiles"),
    ])
      .then(([workspaceRows, profileRows]) => {
        setWorkspaces(workspaceRows);
        setWorkspaceId(workspaceRows[0]?.id ?? "");
        setProfiles(profileRows);
      })
      .catch((error) => setState((error as Error).message));
  }, []);

  async function start() {
    if (!file || !workspaceId || uploading) return;
    abort.current = new AbortController();
    setUploading(true);
    setSpeed("");
    try {
      const runUpload = mode === "direct" ? uploadDirect : upload;
      await runUpload(
        file,
        workspaceId,
        abort.current.signal,
        (bytes, bytesPerSecond) => {
          setState(mode === "direct" ? "Uploading directly to storage" : "Uploading through API");
          setPct(Math.round((bytes / file.size) * 100));
          setSpeed(formatRate(bytesPerSecond));
        },
        (hashPct) => setState(`Checking file integrity · ${hashPct}%`),
        (uploadSession) => {
          if (uploadSession.resumed) {
            setPct(
              Math.round(
                (uploadSession.uploadedBytes / uploadSession.totalSize) * 100,
              ),
            );
            setState(
              mode === "direct"
                ? "Existing direct upload found. Resuming completed storage parts."
                : "Existing upload found. Resuming confirmed API chunks.",
            );
          }
        },
        profile,
      );
      if (abort.current.signal.aborted) setState("Paused. Choose the same file to resume later.");
      else {
        setPct(100);
        setSpeed("");
        setState(`Upload complete. Processing with ${profile}.`);
        setFile(null);
      }
    } catch (error) {
      setState((error as Error).message);
    } finally {
      setUploading(false);
    }
  }

  return (
    <main className="shell">
      <div className="topbar">
        <div>
          <strong>Upload with profile</strong>
          <p>Large files can upload directly to object storage without passing through the API server.</p>
        </div>
        <Link href="/">Back to dashboard</Link>
      </div>

      <section className="panel">
        <label>
          Workspace
          <select
            value={workspaceId}
            onChange={(event) => setWorkspaceId(event.target.value)}
            disabled={uploading}
          >
            {workspaces.map((workspace) => (
              <option key={workspace.id} value={workspace.id}>
                {workspace.name}
              </option>
            ))}
          </select>
        </label>

        <label>
          Upload path
          <select
            value={mode}
            onChange={(event) => setMode(event.target.value as UploadMode)}
            disabled={uploading}
          >
            <option value="direct">Direct to storage · recommended</option>
            <option value="proxy">Through StreamForge API · compatibility</option>
          </select>
        </label>
        <p>
          {mode === "direct"
            ? "The browser sends 8 MiB multipart parts to S3-compatible storage using short-lived signed URLs. Progress survives pause and page reload on this browser."
            : "The API relay path keeps bytes behind StreamForge and is useful when storage CORS is unavailable."}
        </p>

        <label>
          Transcoding profile
          <select
            value={profile}
            onChange={(event) =>
              setProfile(event.target.value as TranscodingProfile)
            }
            disabled={uploading}
          >
            {profiles.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        </label>

        {profiles
          .filter((item) => item.id === profile)
          .map((item) => (
            <p key={item.id}>
              {item.description} Maximum ladder height: {item.maxHeight}p.
            </p>
          ))}

        <input
          type="file"
          accept="video/*"
          disabled={uploading}
          onChange={(event) => {
            setFile(event.target.files?.[0] ?? null);
            setPct(0);
            setSpeed("");
            setState("");
          }}
        />

        {file && <p>{file.name} · {(file.size / 1024 ** 2).toFixed(1)} MiB</p>}
        <progress value={pct} max={100} />
        {(state || speed) && <p>{state}{speed ? ` · ${speed}` : ""}</p>}

        <div className="upload-actions">
          <button className="primary" disabled={!file || uploading} onClick={start}>
            {pct > 0 && !uploading ? "Resume upload" : "Start upload"}
          </button>
          {uploading && (
            <button onClick={() => abort.current?.abort()}>Pause</button>
          )}
        </div>
      </section>
    </main>
  );
}
