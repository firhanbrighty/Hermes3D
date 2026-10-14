"use client";

import { useCallback, useEffect, useState } from "react";

type RecentSession = {
  displayName: string;
  startedAt: number | null;
  messageCount: number | null;
  source: string | null;
};

type ProfileRecord = {
  agentId: string;
  name: string;
  emoji: string;
  role: string;
  workspace: string;
  model: string;
  isDefault: boolean;
  skills: number;
  gatewayRunning: boolean;
  lastActivityAt: number | null;
  sessions: number;
  recentSessions: RecentSession[];
  lastMessage?: { role: string; text: string } | null;
};

type ProfilesSnapshot = {
  workspaceId: string;
  timestamp: string;
  connected: boolean;
  source: "hermes-rest" | "gateway-fleet";
  viewerId?: string | null;
  profiles: ProfileRecord[];
};

const StateBadge = ({ profile }: { profile: ProfileRecord }) => {
  const isWorking = profile.sessions > 0 && profile.lastActivityAt !== null;
  const label = !profile.gatewayRunning ? "Gateway off" : isWorking ? "Active" : "Idle";
  const tone = !profile.gatewayRunning
    ? "bg-[var(--muted)] text-[var(--muted-foreground)] opacity-70"
    : isWorking
      ? "bg-[var(--accent)] text-[var(--accent-foreground)]"
      : "bg-[var(--muted)] text-[var(--muted-foreground)]";
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border border-[var(--border)] px-2.5 py-0.5 text-xs font-medium ${tone}`}>
      <span
        className={
          !profile.gatewayRunning
            ? "h-1.5 w-1.5 rounded-full bg-[var(--muted-foreground)] opacity-40"
            : isWorking
              ? "h-1.5 w-1.5 rounded-full bg-[oklch(0.62_0.17_145)]"
              : "h-1.5 w-1.5 rounded-full bg-[var(--muted-foreground)] opacity-50"
        }
      />
      {label}
    </span>
  );
};

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
    const intervalId = setInterval(() => void refresh(), 30_000);
    return () => clearInterval(intervalId);
  }, [refresh]);

  const activeCount =
    snapshot?.profiles.filter(
      (profile) => profile.gatewayRunning && profile.sessions > 0 && profile.lastActivityAt !== null,
    ).length ?? 0;

  return (
    <main className="mx-auto min-h-screen max-w-5xl px-6 py-10">
      <header className="mb-8">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Hermes Profiles</h1>
            <p className="mt-1 text-sm text-[var(--muted-foreground)]">
              Active profiles from the shared Hermes environment
              {snapshot ? ` · source: ${snapshot.source}` : ""}
              {snapshot?.viewerId ? ` · signed in as ${snapshot.viewerId}` : ""}.
            </p>
          </div>
          <div className="flex items-center gap-2 text-sm">
            <span className="text-[var(--muted-foreground)]">
              {activeCount} active of {snapshot?.profiles.length ?? 0}
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
            Make sure hermes serve is running and the gateway URL/token are configured on the server
            (HERMES3D_GATEWAY_URL / HERMES3D_GATEWAY_TOKEN, or ~/.hermes/hermes3d/settings.json).
          </p>
        </div>
      ) : !snapshot || snapshot.profiles.length === 0 ? (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-4 text-sm text-[var(--muted-foreground)]">
          No profiles reported by the Hermes backend yet.
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
                <StateBadge profile={profile} />
              </div>

              <div className="mt-2 flex flex-wrap gap-1.5 text-[11px] text-[var(--muted-foreground)]">
                {profile.model ? (
                  <span className="rounded bg-[var(--muted)] px-1.5 py-0.5">{profile.model}</span>
                ) : null}
                <span className="rounded bg-[var(--muted)] px-1.5 py-0.5">
                  {profile.skills} skills
                </span>
                {profile.gatewayRunning ? (
                  <span className="rounded bg-[var(--muted)] px-1.5 py-0.5">gateway up</span>
                ) : null}
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
                      <span className="truncate">
                        {session.source ? `${session.source}: ` : ""}
                        {session.displayName}
                        {session.messageCount !== null ? ` (${session.messageCount} msgs)` : ""}
                      </span>
                      <span className="shrink-0">{formatRelativeTime(session.startedAt)}</span>
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