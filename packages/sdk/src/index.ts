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
export type VideoVersion = {
  id: string;
  version_number: number;
  label: string;
  source_video_id?: string;
  filename?: string;
  checksum?: string;
  size: number;
  metadata?: Record<string, unknown>;
  renditions: unknown[];
  created_by: string;
  created_at: string;
  active?: boolean;
};
export type TranscriptSegment = {
  id: string;
  video_id: string;
  subtitle_id: string;
  language: string;
  start_seconds: number;
  end_seconds: number;
  text: string;
  title?: string;
};
export type ReviewComment = {
  id: string;
  video_id: string;
  version_id?: string;
  parent_id?: string;
  author_id: string;
  author_email?: string;
  timestamp_seconds?: number;
  body: string;
  resolved_at?: string;
  resolved_by?: string;
  created_at: string;
  updated_at: string;
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
    versions: {
      list: (id: string) =>
        this.request<VideoVersion[]>(`/videos/${encodeURIComponent(id)}/versions`),
      create: (id: string, input: { sourceVideoId: string; label?: string }) =>
        this.request<VideoVersion>(`/videos/${encodeURIComponent(id)}/versions`, {
          method: "POST",
          body: JSON.stringify(input),
        }),
      activate: (id: string, versionId: string) =>
        this.request(`/videos/${encodeURIComponent(id)}/versions/${encodeURIComponent(versionId)}/activate`, {
          method: "PUT",
          body: JSON.stringify({}),
        }),
      delete: (id: string, versionId: string) =>
        this.request(`/videos/${encodeURIComponent(id)}/versions/${encodeURIComponent(versionId)}`, {
          method: "DELETE",
        }),
    },
    transcript: (
      id: string,
      options: { search?: string; language?: string; limit?: number; offset?: number } = {},
    ) => {
      const q = new URLSearchParams();
      if (options.search) q.set("search", options.search);
      if (options.language) q.set("language", options.language);
      if (options.limit) q.set("limit", String(options.limit));
      if (options.offset) q.set("offset", String(options.offset));
      return this.request<{ items: TranscriptSegment[]; limit: number; offset: number }>(
        `/videos/${encodeURIComponent(id)}/transcript?${q}`,
      );
    },
    review: {
      comments: (id: string) =>
        this.request<ReviewComment[]>(`/videos/${encodeURIComponent(id)}/review-comments`),
      comment: (
        id: string,
        input: {
          versionId?: string;
          parentId?: string;
          timestampSeconds?: number;
          body: string;
        },
      ) =>
        this.request<ReviewComment>(`/videos/${encodeURIComponent(id)}/review-comments`, {
          method: "POST",
          body: JSON.stringify(input),
        }),
      resolve: (id: string, commentId: string, resolved = true) =>
        this.request(`/videos/${encodeURIComponent(id)}/review-comments/${encodeURIComponent(commentId)}`, {
          method: "PATCH",
          body: JSON.stringify({ resolved }),
        }),
      setStatus: (
        id: string,
        status: "pending" | "approved" | "changes_requested",
      ) =>
        this.request(`/videos/${encodeURIComponent(id)}/review-status`, {
          method: "PUT",
          body: JSON.stringify({ status }),
        }),
    },
  };
  transcripts = {
    search: (
      workspaceId: string,
      q: string,
      options: { language?: string; limit?: number } = {},
    ) => {
      const params = new URLSearchParams({ workspaceId, q });
      if (options.language) params.set("language", options.language);
      if (options.limit) params.set("limit", String(options.limit));
      return this.request<TranscriptSegment[]>(
        `/transcripts/search?${params}`,
      );
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
  analyticsRealtime = (id: string) =>
    this.request<{
      activeViewers: number;
      qualities: Record<string, number>;
      devices: Array<{ device_type: string; viewers: string }>;
    }>(`/videos/${encodeURIComponent(id)}/analytics/realtime`);
  analyticsDaily = (id: string) =>
    this.request<
      Array<{
        date: string;
        plays: string;
        unique_viewers: string;
        watch_seconds: string;
        completions: string;
        errors: string;
        buffering_ms: string;
      }>
    >(`/videos/${encodeURIComponent(id)}/analytics/daily`);
}
