"use client";
import Hls from "hls.js";
import { useEffect, useRef, useState } from "react";
import { api, post } from "../lib/api";
type Playback = {
  url: string;
  token: string;
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
  const [buffering, setBuffering] = useState(false);
  const [preview, setPreview] = useState<{
    url: string;
    position: number;
  } | null>(null);
  const cues = useRef<{ start: number; end: number; url: string }[]>([]);
  const startupStartedAt = useRef(0);
  const startupSent = useRef(false);
  const bufferStartedAt = useRef<number | null>(null);
  useEffect(() => {
    let active = true;
    setError("");
    (async () => {
      let p: Playback;
      if (sharedToken) {
        const base = `/api/v1/media/${videoId}/`;
        p = {
          url:
            base + `hls/master.m3u8?token=${encodeURIComponent(sharedToken)}`,
          token: sharedToken,
          poster:
            base +
            `thumbnails/poster.jpg?token=${encodeURIComponent(sharedToken)}`,
          previews:
            base +
            `thumbnails/previews.vtt?token=${encodeURIComponent(sharedToken)}`,
          subtitles: [],
        };
      } else p = await api(`/videos/${videoId}/playback`);
      if (active) setData(p);
    })().catch((e) => setError(e.message));
    return () => {
      active = false;
    };
  }, [videoId, sharedToken, retry]);
  useEffect(() => {
    const video = ref.current;
    if (!data || !video) return;
    let lastTime = Date.now();
    let disposed = false;
    startupStartedAt.current = performance.now();
    startupSent.current = false;
    bufferStartedAt.current = null;
    const currentQuality = () => {
      const hls = engine.current;
      if (!hls || hls.currentLevel < 0) return "auto";
      return hls.levels[hls.currentLevel]?.height
        ? `${hls.levels[hls.currentLevel]!.height}p`
        : "auto";
    };
    const send = (
      event: string,
      watchSeconds = 0,
      durationMs?: number,
      qualityValue?: string,
    ) =>
      void post("/analytics/events", {
        id: crypto.randomUUID(),
        token: data.token,
        event,
        position: video.currentTime || 0,
        watchSeconds,
        quality: qualityValue ?? currentQuality(),
        durationMs:
          durationMs === undefined ? undefined : Math.max(0, Math.round(durationMs)),
      }).catch(() => {});
    if (Hls.isSupported()) {
      const hls = new Hls();
      engine.current = hls;
      hls.loadSource(data.url);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        setLevels(hls.levels.map((l) => ({ height: l.height })));
      });
      hls.on(Hls.Events.ERROR, (_e, d) => {
        if (d.fatal)
          setError(
            "Playback failed. The link may have expired; retry to refresh it.",
          );
      });
      hls.on(Hls.Events.LEVEL_SWITCHED, (_event, details) => {
        const height = hls.levels[details.level]?.height;
        send("quality_change", 0, undefined, height ? `${height}p` : "auto");
      });
    } else if (video.canPlayType("application/vnd.apple.mpegurl"))
      video.src = data.url;
    else setError("This browser does not support HLS playback.");
    const handlers: Record<string, () => void> = {
      loadedmetadata: () => {
        send("video_loaded");
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
        if (bufferStartedAt.current === null)
          bufferStartedAt.current = performance.now();
        send("buffer_start");
      },
      playing: () => {
        setBuffering(false);
        if (bufferStartedAt.current !== null) {
          send("buffer_end", 0, performance.now() - bufferStartedAt.current);
          bufferStartedAt.current = null;
        }
        if (!startupSent.current) {
          startupSent.current = true;
          send("startup", 0, performance.now() - startupStartedAt.current);
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
        send("heartbeat", elapsed, undefined, currentQuality());
        if (!sharedToken)
          void api(`/videos/${videoId}/progress`, {
            method: "PUT",
            body: JSON.stringify({ position: video.currentTime }),
          }).catch(() => {});
      }
    }, 10000);
    void fetch(data.previews)
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
            return [
              {
                start: seconds(start),
                end: seconds(end),
                url: new URL(
                  lines[index + 1],
                  new URL(data.previews, location.href),
                ).toString(),
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
          setPreview(cue ? { url: cue.url, position: p } : null);
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
          <img
            alt="Timeline preview"
            src={preview.url}
            style={{
              left: `${Math.min(85, Math.max(15, preview.position * 100))}%`,
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
