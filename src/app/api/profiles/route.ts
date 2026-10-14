import { NextResponse } from "next/server";
import type {
  SummaryPreviewSnapshot,
  SummaryStatusSnapshot,
} from "@/features/agents/state/runtimeEventBridge";
import {
  NodeGatewayClient,
  buildAgentMainSessionKey,
} from "@/lib/gateway/nodeGatewayClient";
import { loadStudioSettings } from "@/lib/studio/settings-store";

export const runtime = "nodejs";

type GatewayAgentsListResult = {
  defaultId?: string;
  mainKey?: string;
  agents?: Array<{
    id?: string;
    name?: string;
    workspace?: string;
    identity?: { name?: string; emoji?: string };
    role?: string;
  }>;
};

type GatewaySessionListResult = {
  sessions?: Array<{
    key: string;
    agentId: string;
    updatedAt: number | null;
    displayName: string;
  }>;
};

export type ProfileRecord = {
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

export type ProfilesSnapshot = {
  workspaceId: string;
  timestamp: string;
  connected: true;
  profiles: ProfileRecord[];
};

const RECENT_ACTIVITY_MS = 45_000;

const asTrimmedString = (value: unknown) =>
  typeof value === "string" ? value.trim() : "";

const resolveMainSessionKey = (
  agentId: string,
  agentsResult: GatewayAgentsListResult | null,
) => buildAgentMainSessionKey(agentId, asTrimmedString(agentsResult?.mainKey) || "main");

const collectAgentSessions = (
  agentId: string,
  sessionsResult: GatewaySessionListResult | null,
) =>
  (Array.isArray(sessionsResult?.sessions) ? sessionsResult.sessions : []).filter(
    (session) => (asTrimmedString(session.agentId) || "") === agentId && asTrimmedString(session.key),
  );

const resolveLastMessage = (
  mainSessionKey: string,
  previewSnapshot: SummaryPreviewSnapshot | null,
) => {
  const preview = (previewSnapshot?.previews ?? []).find(
    (entry) => entry.key === mainSessionKey,
  );
  const previewItems = preview?.items ?? [];
  return previewItems.length > 0 ? previewItems[previewItems.length - 1] : null;
};

const resolveState = (
  agentId: string,
  agentsResult: GatewayAgentsListResult | null,
  statusSummary: SummaryStatusSnapshot | null,
  previewSnapshot: SummaryPreviewSnapshot | null,
  now: number,
): ProfileRecord["state"] => {
  const previewItems = (previewSnapshot?.previews ?? []).find(
    (entry) => entry.key === resolveMainSessionKey(agentId, agentsResult),
  )?.items;
  if (Array.isArray(previewItems)) {
    for (let index = previewItems.length - 1; index >= 0; index -= 1) {
      const item = previewItems[index];
      if (item?.role === "assistant") return "idle";
      if (item?.role === "user") return "working";
    }
  }
  const recent = (statusSummary?.sessions?.byAgent ?? [])
    .find((entry) => entry.agentId === agentId)
    ?.recent.filter(Boolean) ?? [];
  const latestUpdatedAt = recent.reduce<number | null>((latest, entry) => {
    const updatedAt = typeof entry.updatedAt === "number" ? entry.updatedAt : null;
    if (updatedAt === null) return latest;
    return latest === null ? updatedAt : Math.max(latest, updatedAt);
  }, null);
  if (latestUpdatedAt !== null && now - latestUpdatedAt <= RECENT_ACTIVITY_MS) {
    return "working";
  }
  return "idle";
};

export async function GET() {
  const settings = loadStudioSettings();
  const gatewayUrl = asTrimmedString(settings.gateway?.url);
  if (!gatewayUrl) {
    return NextResponse.json(
      { error: "studio.gateway_url_missing" },
      { status: 503 },
    );
  }

  const gatewayClient = new NodeGatewayClient();
  try {
    await gatewayClient.connect({
      gatewayUrl,
      token: settings.gateway?.token,
    });
    const agentsResult = (await gatewayClient.request(
      "agents.list",
      {},
    )) as GatewayAgentsListResult;
    const agentIds = (agentsResult.agents ?? [])
      .map((agent) => asTrimmedString(agent.id))
      .filter(Boolean);
    const mainSessionKeys = agentIds.map((agentId) =>
      resolveMainSessionKey(agentId, agentsResult),
    );

    const [statusSummary, previewSnapshot, sessionsResult] = await Promise.all([
      gatewayClient.request("status", {}) as Promise<SummaryStatusSnapshot>,
      mainSessionKeys.length > 0
        ? (gatewayClient.request("sessions.preview", {
            keys: mainSessionKeys,
            limit: 8,
            maxChars: 240,
          }) as Promise<SummaryPreviewSnapshot>)
        : Promise.resolve(null),
      gatewayClient.request("sessions.list", {}) as Promise<GatewaySessionListResult>,
    ]);

    const now = Date.now();
    const profiles: ProfileRecord[] = (agentsResult.agents ?? []).flatMap((agent) => {
      const agentId = asTrimmedString(agent.id);
      if (!agentId) return [];
      const name =
        asTrimmedString(agent.identity?.name) || asTrimmedString(agent.name) || agentId;
      const agentSessions = collectAgentSessions(agentId, sessionsResult);
      const recentSessions = agentSessions
        .map((session) => ({
          displayName: asTrimmedString(session.displayName) || "Session",
          updatedAt: typeof session.updatedAt === "number" ? session.updatedAt : null,
        }))
        .sort(
          (a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0),
        )
        .slice(0, 5);
      return [
        {
          agentId,
          name,
          emoji:
            asTrimmedString(agent.identity?.emoji) ||
            (agentId === asTrimmedString(agentsResult?.defaultId) ? "🤖" : "🧑‍💻"),
          role: asTrimmedString(agent.role),
          workspace: asTrimmedString(agent.workspace),
          isDefault: agentId === asTrimmedString(agentsResult?.defaultId),
          state: resolveState(agentId, agentsResult, statusSummary, previewSnapshot, now),
          lastActivityAt:
            recentSessions[0]?.updatedAt ?? null,
          lastMessage: resolveLastMessage(
            resolveMainSessionKey(agentId, agentsResult),
            previewSnapshot,
          ),
          sessions: agentSessions.length,
          recentSessions,
        },
      ];
    });

    const snapshot: ProfilesSnapshot = {
      workspaceId: "default",
      timestamp: new Date(now).toISOString(),
      connected: true,
      profiles,
    };
    return NextResponse.json(snapshot, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to load profile roster.";
    console.error("[profiles] Failed to load profile roster.", { error: message });
    return NextResponse.json({ error: message }, { status: 502 });
  } finally {
    gatewayClient.close();
  }
}