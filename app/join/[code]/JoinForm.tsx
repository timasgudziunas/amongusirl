"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { api, setCode, setToken } from "@/lib/client";

export default function JoinForm({ code }: { code: string }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [joining, setJoining] = useState(false);

  async function handleJoin(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setJoining(true);
    const res = await api<{ token: string; playerId: string }>("/api/join", {
      body: { code, name },
    });
    setJoining(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setToken(res.token);
    setCode(code);
    router.push(`/room/${code}`);
  }

  return (
    <main className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-6 px-6 py-16">
      <h1 className="text-center text-2xl tracking-wide">JOIN {code}</h1>
      <form onSubmit={handleJoin} className="flex flex-col gap-3">
        <input
          className="au-input"
          placeholder="Your name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={40}
          autoFocus
          required
        />
        {error && <p className="au-error">{error}</p>}
        <button type="submit" className="au-button" disabled={joining}>
          {joining ? "Joining..." : "Join"}
        </button>
      </form>
    </main>
  );
}
