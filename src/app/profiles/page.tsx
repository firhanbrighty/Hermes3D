"use client";

import { useCallback, useEffect, useState } from "react";

type ProfileRecord = {
  agentId: string;
  name: string;
  emoji: string;
  role: string;
  workspace: string;
  isDefault: boolean;
  state: "working" | "idle";
  lastActivityAt: number | null;
  lastMessage: { role: string; text: string; timestamp?: number | string } | null;
  sessions: number;
  recentSessions: Array<{ displayName: string; updatedAt: number | null }>;
};

type ProfilesSnapshot = {
  workspaceId: string;
  timestamp: string;
  connected: boolean;
  profiles: ProfileRecord[];
};

const StateBadge = ({ state }: { state: ProfileRecord["state"] }) => (
  <span
    className={
      state === "working"
        ? "inline-flex items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--accent)] px-2.5 py-0.5 text-xs font-medium text-[var(--accent-foreground)]"
        : "inline-flex items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--muted)] px-2.5 py-0.5 text-xs font-medium text-[var(--muted-foreground)]"
    }
  >
    <span
      className={
        state === "working"
          ? "h-1.5 w-1.5 rounded-full bg-[oklch(0.62_0.17_145)]"
          : "h-1.5 w-1.5 rounded-full bg-[var(--muted-foreground)] opacity-50"
      }
    />
    {state === "working" ? "Working" : "Idle"}
  </span>
);

const formatRelativeTime = (timestampMs: number | null) => {
  if (timestampMs === null) return "no activity";
  const deltaMs = Date.now() - timestampMs;
  if (deltaMs < 60_000) return `${Math.max(1, Math.floor(deltaMs / 1000))}s ago`;
  if (deltaMs < 3_600_000) return `${Math.floor(deltaMs / 60_000)}m ago`;
  if (deltaMs < 86_400_000) return `${Math.floor(deltaMs / 3_600_000)}h ago`;
  return `${Math.floor(deltaMs / 86_400_000)}d ago`;
};

export default function ProfilesPage() {
  const [snapshot, setSnapshot] = useState<ProfilesSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const response = await fetch("/api/profiles", { cache: "no-store" });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `Request failed (${response.status})`);
      }
      setSnapshot((await response.json()) as ProfilesSnapshot);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load profiles.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const intervalId = setInterval(() => void refresh(), 15_000);
    return () => clearInterval(intervalId);
  }, [refresh]);

  const workingCount = snapshot?.profiles.filter((p) => p.state === "working").length ?? 0;
  const idleCount = snapshot?.profiles.filter((p) => p.state === "idle").length ?? 0;

  return (
    <main className="mx-auto min-h-screen max-w-5xl px-6 py-10">
      <header className="mb-8">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Hermes Profiles</h1>
            <p className="mt-1 text-sm text-[var(--muted-foreground)]">
              Active profiles from the connected Hermes environment.
            </p>
          </div>
          <div className="flex items-center gap-2 text-sm">
            <span className="text-[var(--muted-foreground)]">
              {workingCount} working · {idleCount} idle
            </span>
            <button
              onClick={() => void refresh()}
              className="rounded-md border border-[var(--border)] px-3 py-1.5 text-sm font-medium hover:bg-[var(--accent)]"
            >
              Refresh
            </button>
          </div>
        </div>
      </header>

      {loading ? (
        <p className="text-sm text-[var(--muted-foreground)]">Loading profiles…</p>
      ) : error ? (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-4 text-sm">
          <p className="font-medium text-[var(--destructive)]">Could not load profiles</p>
          <p className="mt-1 text-[var(--muted-foreground)]">{error}</p>
          <p className="mt-2 text-xs text-[var(--muted-foreground)]">
            Make sure Hermes3D Studio is connected to the gateway (connect screen in the office UI,
            or HERMES3D_GATEWAY_URL / HERMES3D_GATEWAY_TOKEN in .env).
          </p>
        </div>
      ) : !snapshot || snapshot.profiles.length === 0 ? (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-4 text-sm text-[var(--muted-foreground)]">
          No profiles reported by the gateway yet.
        </div>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2">
          {snapshot.profiles.map((profile) => (
            <li
              key={profile.agentId}
              className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-4"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-2.5">
                  <span className="text-2xl">{profile.emoji}</span>
                  <div>
                    <p className="font-medium leading-tight">
                      {profile.name}
                      {profile.isDefault ? (
                        <span className="ml-2 rounded border border-[var(--border)] px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-[var(--muted-foreground)]">
                          default
                        </span>
                      ) : null}
                    </p>
                    <p className="text-xs text-[var(--muted-foreground)]">
                      {profile.agentId}
                      {profile.role ? ` · ${profile.role}` : ""}
                    </p>
                  </div>
                </div>
                <StateBadge state={profile.state} />
              </div>

              <p className="mt-3 text-sm text-[var(--muted-foreground)]">
                Last active: {formatRelativeTime(profile.lastActivityAt)} ·{" "}
                {profile.sessions} session{profile.sessions === 1 ? "" : "s"}
              </p>

              {profile.lastMessage ? (
                <p className="mt-2 line-clamp-2 rounded-md bg-[var(--muted)] px-2.5 py-1.5 text-xs text-[var(--muted-foreground)]">
                  <span className="font-medium capitalize">{profile.lastMessage.role}</span>:{" "}
                  {profile.lastMessage.text}
                </p>
              ) : null}

              {profile.recentSessions.length > 0 ? (
                <ul className="mt-3 space-y-1 text-xs text-[var(--muted-foreground)]">
                  {profile.recentSessions.map((session) => (
                    <li key={session.displayName} className="flex justify-between gap-2">
                      <span className="truncate">{session.displayName}</span>
                      <span className="shrink-0">{formatRelativeTime(session.updatedAt)}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}