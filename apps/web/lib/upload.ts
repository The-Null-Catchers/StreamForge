import { createSHA256 } from "hash-wasm";
import { api, post } from "./api";

export type UploadSessionInfo = {
  id: string;
  resumed: boolean;
  uploadedBytes: number;
  totalSize: number;
  chunkSize: number;
};

export type TranscodingProfile = "data_saver" | "balanced" | "quality";

export async function fileHash(file: File, onProgress?: (pct: number) => void) {
  const h = await createSHA256();
  h.init();
  for (let n = 0; n < file.size; n += 8388608) {
    h.update(new Uint8Array(await file.slice(n, n + 8388608).arrayBuffer()));
    onProgress?.(
      Math.round((Math.min(file.size, n + 8388608) / file.size) * 100),
    );
  }
  return h.digest("hex");
}

export async function upload(
  file: File,
  workspaceId: string,
  signal: AbortSignal,
  onProgress: (bytes: number, speed: number) => void,
  onHash: (pct: number) => void,
  onSession?: (session: UploadSessionInfo) => void,
  transcodingProfile: TranscodingProfile = "balanced",
) {
  const checksum = await fileHash(file, onHash);
  if (signal.aborted) return;
  const key = `sf_upload_${workspaceId}_${checksum}`;
  let id = localStorage.getItem(key);
  let state;
  let resumed = false;

  if (id) {
    state = await api(`/uploads/${id}`);
    if (state.status !== "uploading") {
      localStorage.removeItem(key);
      id = null;
    } else {
      resumed = true;
    }
  }

  if (!id) {
    const v = await post("/videos", {
      workspaceId,
      title: file.name.replace(/\.[^.]+$/, ""),
      privacy: "private",
      transcodingProfile,
    });
    state = await post("/uploads", {
      workspaceId,
      videoId: v.id,
      filename: file.name,
      mimeType: file.type || "video/mp4",
      totalSize: file.size,
      checksum,
    });
    id = state.id;
    localStorage.setItem(key, id!);
  }

  const confirmed = await api(`/uploads/${id}`);
  onSession?.({
    id: id!,
    resumed,
    uploadedBytes: Number(confirmed.uploaded_bytes),
    totalSize: Number(confirmed.total_size),
    chunkSize: Number(confirmed.chunk_size),
  });

  const parts = new Set<number>(
    confirmed.parts.map((p: { part_number: number }) => p.part_number),
  );
  let completed = Number(confirmed.uploaded_bytes);
  const start = performance.now();
  const initial = completed;

  if (completed > 0) onProgress(completed, 0);

  for (let n = 0; n < Math.ceil(file.size / confirmed.chunk_size); n++) {
    if (signal.aborted) return;
    if (parts.has(n)) continue;
    const chunk = await file
      .slice(n * confirmed.chunk_size, (n + 1) * confirmed.chunk_size)
      .arrayBuffer();
    const sha = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", chunk)),
    )
      .map((x) => x.toString(16).padStart(2, "0"))
      .join("");
    let succeeded = false;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        await api(`/uploads/${id}/parts/${n}`, {
          method: "PUT",
          body: chunk,
          signal,
          headers: {
            "Content-Type": "application/octet-stream",
            "X-Checksum-Sha256": sha,
          },
        });
        succeeded = true;
        break;
      } catch (e) {
        if (signal.aborted) return;
        if (attempt === 3) throw e;
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
      }
    }
    if (succeeded) {
      completed += chunk.byteLength;
      onProgress(
        completed,
        (completed - initial) / ((performance.now() - start) / 1000),
      );
    }
  }

  if (!signal.aborted) {
    await post(`/uploads/${id}/complete`, {});
    localStorage.removeItem(key);
  }
}
