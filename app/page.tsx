"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { api, setCode, setPin, setToken } from "@/lib/client";

export default function Home() {
  const router = useRouter();

  const [hostName, setHostName] = useState("");
  const [hostPin, setHostPin] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const [joinCode, setJoinCode] = useState("");
  const [joinName, setJoinName] = useState("");
  const [joinError, setJoinError] = useState<string | null>(null);
  const [joining, setJoining] = useState(false);

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    setCreateError(null);
    setCreating(true);
    const res = await api<{ code: string; token: string; playerId: string }>("/api/room", {
      body: { hostName, pin: hostPin },
    });
    setCreating(false);
    if (!res.ok) {
      setCreateError(res.error);
      return;
    }
    setToken(res.token);
    setCode(res.code);
    setPin(hostPin);
    router.push(`/host/${res.code}`);
  }

  async function handleJoin(e: FormEvent) {
    e.preventDefault();
    setJoinError(null);
    setJoining(true);
    const code = joinCode.trim().toUpperCase();
    const res = await api<{ token: string; playerId: string }>("/api/join", {
      body: { code, name: joinName },
    });
    setJoining(false);
    if (!res.ok) {
      setJoinError(res.error);
      return;
    }
    setToken(res.token);
    setCode(code);
    router.push(`/room/${code}`);
  }

  return (
    <main className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-12 px-6 py-16">
      <h1 className="text-center text-2xl tracking-wide">AMONG US IRL</h1>

      <form onSubmit={handleCreate} className="flex flex-col gap-3">
        <h2 className="au-dim text-sm uppercase tracking-wider">Create a room</h2>
        <input
          className="au-input"
          placeholder="Your name"
          value={hostName}
          onChange={(e) => setHostName(e.target.value)}
          maxLength={40}
          required
        />
        <input
          className="au-input"
          placeholder="4-digit host PIN"
          inputMode="numeric"
          pattern="[0-9]{4}"
          maxLength={4}
          value={hostPin}
          onChange={(e) => setHostPin(e.target.value.replace(/\D/g, "").slice(0, 4))}
          required
        />
        {createError && <p className="au-error">{createError}</p>}
        <button type="submit" className="au-button" disabled={creating}>
          {creating ? "Creating..." : "Create room"}
        </button>
      </form>

      <form onSubmit={handleJoin} className="flex flex-col gap-3">
        <h2 className="au-dim text-sm uppercase tracking-wider">Join a room</h2>
        <input
          className="au-input"
          placeholder="Room code"
          maxLength={4}
          value={joinCode}
          onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
          required
        />
        <input
          className="au-input"
          placeholder="Your name"
          value={joinName}
          onChange={(e) => setJoinName(e.target.value)}
          maxLength={40}
          required
        />
        {joinError && <p className="au-error">{joinError}</p>}
        <button type="submit" className="au-button" disabled={joining}>
          {joining ? "Joining..." : "Join"}
        </button>
      </form>
    </main>
  );
}
