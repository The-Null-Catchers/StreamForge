export type Video = {
  id: string;
  workspace_id: string;
  title: string;
  status: string;
  privacy: "private" | "unlisted" | "public";
  progress: Record<string, number>;
};
export type Upload = {
  id: string;
  chunk_size: number;
  uploaded_bytes: string;
  parts?: { part_number: number; checksum: string }[];
};
export type Chapter = {
  id?: string;
  start_seconds?: number;
  startSeconds?: number;
  title: string;
};
export type Playlist = {
  id: string;
  workspace_id: string;
  name: string;
  created_at: string;
  item_count?: number;
  items?: Array<Video & { position: number }>;
};
export class StreamForge {
  constructor(private options: { apiKey: string; baseUrl?: string }) {}
  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const r = await fetch(
      `${this.options.baseUrl ?? "http://localhost:8080"}/api/v1${path}`,
      {
        ...init,
        headers: {
          ...(init.body !== undefined
            ? { "Content-Type": "application/json" }
            : {}),
          Authorization: `Bearer ${this.options.apiKey}`,
          ...init.headers,
        },
      },
    );
    const b = await r.json();
    if (!r.ok) throw new Error(`${b.error?.code}: ${b.error?.message}`);
    return b as T;
  }
  videos = {
    create: (input: { workspaceId: string; title: string; privacy?: string }) =>
      this.request<Video>("/videos", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    list: (workspaceId: string) =>
      this.request<{ items: Video[] }>(
        `/videos?workspaceId=${encodeURIComponent(workspaceId)}`,
      ),
    get: (id: string) =>
      this.request<Video>(`/videos/${encodeURIComponent(id)}`),
    delete: (id: string) =>
      this.request(`/videos/${encodeURIComponent(id)}`, { method: "DELETE" }),
    chapters: {
      list: (id: string) =>
        this.request<Chapter[]>(`/videos/${encodeURIComponent(id)}/chapters`),
      replace: (id: string, chapters: Array<{ startSeconds: number; title: string }>) =>
        this.request(`/videos/${encodeURIComponent(id)}/chapters`, {
          method: "PUT",
          body: JSON.stringify({ chapters }),
        }),
    },
  };
  playlists = {
    list: (workspaceId: string) =>
      this.request<Playlist[]>(
        `/playlists?workspaceId=${encodeURIComponent(workspaceId)}`,
      ),
    create: (input: { workspaceId: string; name: string }) =>
      this.request<Playlist>("/playlists", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    get: (id: string) =>
      this.request<Playlist>(`/playlists/${encodeURIComponent(id)}`),
    rename: (id: string, name: string) =>
      this.request(`/playlists/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify({ name }),
      }),
    replaceItems: (id: string, videoIds: string[]) =>
      this.request(`/playlists/${encodeURIComponent(id)}/items`, {
        method: "PUT",
        body: JSON.stringify({ videoIds }),
      }),
    delete: (id: string) =>
      this.request(`/playlists/${encodeURIComponent(id)}`, {
        method: "DELETE",
      }),
  };
  uploads = {
    create: (input: {
      workspaceId: string;
      videoId: string;
      filename: string;
      mimeType: string;
      totalSize: number;
      checksum: string;
    }) =>
      this.request<Upload>("/uploads", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    get: (id: string) =>
      this.request<Upload>(`/uploads/${encodeURIComponent(id)}`),
    complete: (id: string) =>
      this.request(`/uploads/${encodeURIComponent(id)}/complete`, {
        method: "POST",
      }),
    cancel: (id: string) =>
      this.request(`/uploads/${encodeURIComponent(id)}`, { method: "DELETE" }),
    part: (id: string, part: number, body: Uint8Array, checksum: string) =>
      this.request(`/uploads/${encodeURIComponent(id)}/parts/${part}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/octet-stream",
          "X-Checksum-Sha256": checksum,
        },
        body: body as BodyInit,
      }),
  };
  playback = (id: string) =>
    this.request<{ url: string; token: string; embedUrl: string }>(
      `/videos/${encodeURIComponent(id)}/playback`,
    );
  analytics = (id: string) =>
    this.request<Record<string, number>>(
      `/videos/${encodeURIComponent(id)}/analytics`,
    );
}
