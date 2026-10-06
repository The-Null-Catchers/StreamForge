"use client";
import Hls from "hls.js";
import { useEffect, useRef, useState } from "react";
import { api, post } from "../lib/api";
type Playback = {
  url: string;
  cmafUrl: string;
  token: string;
  expiresIn: number;
  poster: string;
  previews: string;
  subtitles: {
    id: string;
    url: string;
    language: string;
    label: string;
    default: boolean;
  }[];
};
type PreviewCue = {
  start: number;
  end: number;
  url: string;
  x: number;
  y: number;
  width: number;
  height: number;
};
type PlayerAudioTrack = {
  id: number;
  name: string;
  language: string;
};
export default function Player({
  videoId,
  sharedToken,
}: {
  videoId: string;
  sharedToken?: string;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const engine = useRef<Hls | null>(null);
  const [data, setData] = useState<Playback | null>(null);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [levels, setLevels] = useState<{ height: number }[]>([]);
  const [quality, setQuality] = useState(-1);
  const [audioTracks, setAudioTracks] = useState<PlayerAudioTrack[]>([]);
  const [audioTrack, setAudioTrack] = useState(-1);
  const [buffering, setBuffering] = useState(false);
  const [preview, setPreview] = useState<{
    cue: PreviewCue;
    position: number;
  } | null>(null);
  const cues = useRef<PreviewCue[]>([]);
  const resumeAt = useRef<number | null>(null);
  const parentOrigin = () => {
    if (!sharedToken || !document.referrer) return undefined;
    try {
      return new URL(document.referrer).origin;
    } catch {
      return undefined;
    }
  };
  useEffect(() => {
    let active = true;
    setError("");
    (async () => {
      const p: Playback = sharedToken
        ? await post(`/videos/${videoId}/embed/playback`, {
            token: sharedToken,
            parentOrigin: parentOrigin(),
          })
        : await api(`/videos/${videoId}/playback`);
      if (active) setData(p);
    })().catch((e) => setError(e.message));
    return () => {
      active = false;
    };
  }, [videoId, sharedToken, retry]);
  useEffect(() => {
    if (!data) return;
    const delaySeconds = Math.max(30, data.expiresIn - 60);
    const timer = window.setTimeout(() => {
      const currentTime = ref.current?.currentTime ?? 0;
      void post(`/videos/${videoId}/playback/refresh`, {
        token: data.token,
        ...(sharedToken ? { parentOrigin: parentOrigin() } : {}),
      })
        .then((renewed: Playback) => {
          resumeAt.current = currentTime;
          setData(renewed);
          setError("");
        })
        .catch(() =>
          setError(
            "Playback authorization could not be renewed. Retry playback to continue.",
          ),
        );
    }, delaySeconds * 1000);
    return () => window.clearTimeout(timer);
  }, [data, videoId]);

  useEffect(() => {
    const video = ref.current;
    if (!data || !video) return;
    let lastTime = Date.now();
    const loadStartedAt = performance.now();
    let startupSent = false;
    let disposed = false;
    setLevels([]);
    setQuality(-1);
    setAudioTracks([]);
    setAudioTrack(-1);
    const ua = navigator.userAgent.toLowerCase();
    const deviceType = /ipad|tablet/.test(ua)
      ? "tablet"
      : /iphone|android.*mobile|mobile/.test(ua)
        ? "mobile"
        : /smart-tv|smarttv|hbbtv|appletv/.test(ua)
          ? "tv"
          : "desktop";
    const browserFamily = /edg\//.test(ua)
      ? "edge"
      : /firefox\//.test(ua)
        ? "firefox"
        : /chrome\//.test(ua) || /crios\//.test(ua)
          ? "chrome"
          : /safari\//.test(ua)
            ? "safari"
            : "other";
    const osFamily = /iphone|ipad|ios/.test(ua)
      ? "ios"
      : /android/.test(ua)
        ? "android"
        : /windows/.test(ua)
          ? "windows"
          : /mac os|macintosh/.test(ua)
            ? "macos"
            : /linux/.test(ua)
              ? "linux"
              : "other";
    const send = (
      event: string,
      watchSeconds = 0,
      extras: Record<string, unknown> = {},
    ) =>
      void post("/analytics/events", {
        id: crypto.randomUUID(),
        token: data.token,
        event,
        position: video.currentTime || 0,
        watchSeconds,
        deviceType,
        browserFamily,
        osFamily,
        ...extras,
      }).catch(() => {});
    if (Hls.isSupported()) {
      const hls = new Hls();
      engine.current = hls;
      const syncAudioTracks = () => {
        const tracks = hls.audioTracks.map((track, id) => ({
          id,
          name: track.name || track.lang || `Track ${id + 1}`,
          language: track.lang || "",
        }));
        setAudioTracks(tracks);
        setAudioTrack(hls.audioTrack);
      };
      hls.loadSource(data.cmafUrl || data.url);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        setLevels(hls.levels.map((l) => ({ height: l.height })));
        syncAudioTracks();
      });
      hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, syncAudioTracks);
      hls.on(Hls.Events.AUDIO_TRACK_SWITCHED, (_event, detail) => {
        setAudioTrack(detail.id);
        const track = hls.audioTracks[detail.id];
        send("audio_track_change", 0, {
          audioTrack: track?.name || track?.lang || `Track ${detail.id + 1}`,
          ...(track?.lang ? { audioLanguage: track.lang } : {}),
        });
      });
      hls.on(Hls.Events.ERROR, (_e, d) => {
        if (d.fatal)
          setError(
            "Playback failed. The link may have expired; retry to refresh it.",
          );
      });
      hls.on(Hls.Events.LEVEL_SWITCHED, (_event, detail) => {
        const height = hls.levels[detail.level]?.height;
        send("quality_change", 0, height ? { quality: `${height}p` } : {});
      });
    } else if (video.canPlayType("application/vnd.apple.mpegurl"))
      video.src = data.url;
    else setError("This browser does not support HLS playback.");
    const handlers: Record<string, () => void> = {
      loadedmetadata: () => {
        send("video_loaded");
        if (resumeAt.current !== null) {
          const target = resumeAt.current;
          resumeAt.current = null;
          if (!disposed && target < video.duration - 1) video.currentTime = target;
          return;
        }
        if (!sharedToken)
          void api(`/videos/${videoId}/progress`)
            .then((p) => {
              if (!disposed && p.position < video.duration - 3)
                video.currentTime = p.position;
            })
            .catch(() => {});
      },
      play: () => {
        lastTime = Date.now();
        send("play");
      },
      pause: () => send("pause"),
      seeked: () => send("seek"),
      waiting: () => {
        setBuffering(true);
        send("buffer_start");
      },
      playing: () => {
        setBuffering(false);
        send("buffer_end");
        if (!startupSent) {
          startupSent = true;
          send("video_loaded", 0, {
            startupMs: Math.max(0, Math.round(performance.now() - loadStartedAt)),
          });
        }
      },
      ended: () => send("ended"),
      error: () => send("error"),
    };
    for (const [name, fn] of Object.entries(handlers))
      video.addEventListener(name, fn);
    const timer = setInterval(() => {
      const elapsed = Math.min(15, (Date.now() - lastTime) / 1000);
      lastTime = Date.now();
      if (!video.paused && !video.seeking && video.readyState >= 3) {
        send("heartbeat", elapsed);
        if (!sharedToken)
          void api(`/videos/${videoId}/progress`, {
            method: "PUT",
            body: JSON.stringify({ position: video.currentTime }),
          }).catch(() => {});
      }
    }, 10000);
    const previewsUrl = new URL(data.previews, location.href);
    void fetch(previewsUrl)
      .then((r) => r.text())
      .then((text) => {
        const seconds = (s: string) =>
          s.split(":").reduce((n, x) => n * 60 + Number(x), 0);
        cues.current = text
          .split("\n\n")
          .slice(1)
          .flatMap((block) => {
            const lines = block.trim().split("\n");
            const index = lines.findIndex((x) => x.includes(" --> "));
            if (index < 0 || !lines[index + 1]) return [];
            const [start, end] = lines[index].split(" --> ");
            const rawTarget = lines[index + 1];
            const [resource, fragment = ""] = rawTarget.split("#", 2);
            const crop = /^xywh=(\d+),(\d+),(\d+),(\d+)$/.exec(fragment);
            const imageUrl = new URL(resource, previewsUrl);
            const token = previewsUrl.searchParams.get("token");
            if (token) imageUrl.searchParams.set("token", token);
            return [
              {
                start: seconds(start),
                end: seconds(end),
                url: imageUrl.toString(),
                x: crop ? Number(crop[1]) : 0,
                y: crop ? Number(crop[2]) : 0,
                width: crop ? Number(crop[3]) : 240,
                height: crop ? Number(crop[4]) : 135,
              },
            ];
          });
      })
      .catch(() => {});
    return () => {
      disposed = true;
      clearInterval(timer);
      for (const [name, fn] of Object.entries(handlers))
        video.removeEventListener(name, fn);
      engine.current?.destroy();
      engine.current = null;
    };
  }, [data, videoId, sharedToken]);
  return (
    <div
      className="player"
      tabIndex={0}
      onKeyDown={(e) => {
        const v = ref.current;
        if (!v || (e.target as HTMLElement).tagName === "SELECT") return;
        if (e.key === " " || e.key === "k") {
          e.preventDefault();
          if (v.paused) void v.play();
          else v.pause();
        }
        if (e.key === "ArrowRight")
          v.currentTime = Math.min(v.duration, v.currentTime + 5);
        if (e.key === "ArrowLeft")
          v.currentTime = Math.max(0, v.currentTime - 5);
        if (e.key === "m") v.muted = !v.muted;
        if (e.key === "f") void v.requestFullscreen();
      }}
    >
      <video
        ref={ref}
        controls
        playsInline
        poster={data?.poster}
        crossOrigin="anonymous"
      >
        {data?.subtitles.map((s) => (
          <track
            key={s.id}
            src={s.url}
            kind="subtitles"
            srcLang={s.language}
            label={s.label}
            default={s.default}
          />
        ))}
      </video>
      {buffering && <span className="buffering">Buffering…</span>}
      {error && (
        <div className="notice error">
          {error}
          <button
            onClick={() => {
              setData(null);
              setRetry((x) => x + 1);
            }}
          >
            Retry playback
          </button>
        </div>
      )}
      <div
        className="scrub"
        onMouseLeave={() => setPreview(null)}
        onMouseMove={(e) => {
          const v = ref.current;
          if (!v?.duration) return;
          const box = e.currentTarget.getBoundingClientRect();
          const p = Math.max(
            0,
            Math.min(1, (e.clientX - box.left) / box.width),
          );
          const cue = cues.current.find(
            (c) => c.start <= p * v.duration && c.end > p * v.duration,
          );
          setPreview(cue ? { cue, position: p } : null);
        }}
        onClick={(e) => {
          const v = ref.current;
          if (v?.duration) {
            const b = e.currentTarget.getBoundingClientRect();
            v.currentTime = ((e.clientX - b.left) / b.width) * v.duration;
          }
        }}
        aria-label="Preview timeline"
      >
        {preview && (
          <span
            aria-label="Timeline preview"
            role="img"
            style={{
              position: "absolute",
              bottom: "2rem",
              left: `${Math.min(85, Math.max(15, preview.position * 100))}%`,
              width: `${preview.cue.width}px`,
              height: `${preview.cue.height}px`,
              transform: "translateX(-50%)",
              backgroundImage: `url(${JSON.stringify(preview.cue.url)})`,
              backgroundRepeat: "no-repeat",
              backgroundPosition: `-${preview.cue.x}px -${preview.cue.y}px`,
              borderRadius: "8px",
              boxShadow: "0 8px 24px rgba(0, 0, 0, 0.45)",
              pointerEvents: "none",
              zIndex: 2,
            }}
          />
        )}
        <span>Hover to preview · Click to seek</span>
      </div>
      <div className="player-tools">
        <label>
          Quality{" "}
          <select
            value={quality}
            onChange={(e) => {
              const value = Number(e.target.value);
              setQuality(value);
              if (engine.current) engine.current.currentLevel = value;
            }}
          >
            <option value={-1}>Auto</option>
            {levels.map((l, i) => (
              <option key={i} value={i}>
                {l.height}p
              </option>
            ))}
          </select>
        </label>
        {audioTracks.length > 1 && (
          <label>
            Audio{" "}
            <select
              aria-label="Audio track"
              value={audioTrack}
              onChange={(e) => {
                const value = Number(e.target.value);
                setAudioTrack(value);
                if (engine.current) engine.current.audioTrack = value;
              }}
            >
              {audioTracks.map((track) => (
                <option key={track.id} value={track.id}>
                  {track.name}
                  {track.language && track.name !== track.language
                    ? ` (${track.language})`
                    : ""}
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          Speed{" "}
          <select
            defaultValue="1"
            onChange={(e) => {
              if (ref.current)
                ref.current.playbackRate = Number(e.target.value);
            }}
          >
            {[0.5, 0.75, 1, 1.25, 1.5, 2].map((x) => (
              <option key={x} value={x}>
                {x}×
              </option>
            ))}
          </select>
        </label>
        <button
          onClick={() =>
            void ref.current
              ?.requestPictureInPicture?.()
              .catch(() => setError("Picture-in-picture is unavailable."))
          }
        >
          Picture in picture
        </button>
        <small>Space play · ← → seek · M mute · F fullscreen</small>
      </div>
    </div>
  );
}
