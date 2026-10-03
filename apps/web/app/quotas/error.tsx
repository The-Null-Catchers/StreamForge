"use client";

export default function ErrorState({ reset }: { reset: () => void }) {
  return (
    <main className="shell">
      <section className="panel">
        <h2>Quota administration could not load</h2>
        <button onClick={reset}>Retry</button>
      </section>
    </main>
  );
}
