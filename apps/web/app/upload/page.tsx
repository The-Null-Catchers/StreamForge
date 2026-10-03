"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
  upload,
  type TranscodingProfile,
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

export default function UploadPage() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState("");
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [profile, setProfile] = useState<TranscodingProfile>("balanced");
  const [file, setFile] = useState<File | null>(null);
  const [state, setState] = useState("");
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
    try {
      await upload(
        file,
        workspaceId,
        abort.current.signal,
        (bytes) => {
          setState("Uploading");
          setPct(Math.round((bytes / file.size) * 100));
        },
        (hashPct) => setState(`Checking file integrity · ${hashPct}%`),
        (uploadSession) => {
          if (uploadSession.resumed) {
            setPct(
              Math.round(
                (uploadSession.uploadedBytes / uploadSession.totalSize) * 100,
              ),
            );
            setState("Existing upload found. Resuming confirmed chunks.");
          }
        },
        profile,
      );
      if (abort.current.signal.aborted) setState("Paused. Resume when ready.");
      else {
        setPct(100);
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
          <p>Choose the quality/storage tradeoff before processing starts.</p>
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
            {workspaces.map((workspace) => (
              <option key={workspace.id} value={workspace.id}>
                {workspace.name}
              </option>
            ))}
          </select>
        </label>

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
          onChange={(event) => setFile(event.target.files?.[0] ?? null)}
        />

        {file && <p>{file.name}</p>}
        <progress value={pct} max={100} />
        {state && <p>{state}</p>}

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
