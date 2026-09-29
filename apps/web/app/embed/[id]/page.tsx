"use client";
import { use, useEffect, useState } from "react";
import Player from "../../../components/Player";
export default function Embed({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [token, setToken] = useState<string | undefined>();
  const [ready, setReady] = useState(false);
  useEffect(() => {
    setToken(
      new URLSearchParams(location.hash.slice(1)).get("token") ?? undefined,
    );
    setReady(true);
  }, []);
  return (
    <main className="embed">
      {ready && <Player videoId={id} sharedToken={token} />}
    </main>
  );
}
