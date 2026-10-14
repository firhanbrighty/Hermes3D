import { NextResponse } from "next/server";
import {
  NodeGatewayClient,
  buildAgentMainSessionKey,
} from "@/lib/gateway/nodeGatewayClient";
import { loadStudioSettings } from "@/lib/studio/settings-store";

export const runtime = "nodejs";

type HermesRestProfile = {
  name?: string;
  path?: string;
  is_default?: boolean;
  model?: string | null;
  provider?: string | null;
  skill_count?: number;
  gateway_running?: boolean;
  description?: string;
};

type HermesRestSessionsResponse = {
  sessions?: Array<{
    id?: string;
    display_name?: string | null;
    profile?: string;
    started_at?: number | null;
    ended_at?: number | null;
    message_count?: number;
    source?: string | null;
    model?: string | null;
  }>;
};

export type ProfileRecord = {
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
  recentSessions: Array<{
    displayName: string;
    startedAt: number | null;
    messageCount: number | null;
    source: string | null;
  }>;
};

export type ProfilesSnapshot = {
  workspaceId: string;
  timestamp: string;
  connected: boolean;
  source: "hermes-rest" | "gateway-fleet";
  viewerId?: string | null;
  profiles: ProfileRecord[];
};

const asTrimmedString = (value: unknown) =>
  typeof value === "string" ? value.trim() : "";

const titleCaseProfileName = (name: string) =>
  name ? name.charAt(0).toUpperCase() + name.slice(1) : "";

const roleFromDescription = (description: string) =>
  description.includes("—") ? description.split("—").slice(1).join("—").trim() : "";

const fetchWithTimeout = async (url: string, headers: HeadersInit, timeoutMs: number) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { headers, signal: controller.signal, cache: "no-store" });
  } finally {
    clearTimeout(timer);
  }
};

const restBaseUrlFromGatewayUrl = (gatewayUrl: string) => {
  if (gatewayUrl.startsWith("http://") || gatewayUrl.startsWith("https://")) return gatewayUrl;
  return gatewayUrl.replace(/^wss:/, "https:").replace(/^ws:/, "http:");
};

const loadProfilesViaHermesRest = async (params: {
  baseUrl: string;
  token: string;
}): Promise<ProfilesSnapshot> => {
  const headers = { Authorization: `Bearer ${params.token}` };
  const base = params.baseUrl.replace(/\/+$/, "");

  const profilesResponse = await fetchWithTimeout(`${base}/api/profiles`, headers, 12_000);
  if (!profilesResponse.ok) throw new Error(`profiles endpoint HTTP ${profilesResponse.status}`);
  const profilesData = (await profilesResponse.json()) as { profiles?: HermesRestProfile[] };
  const restProfiles = profilesData.profiles ?? [];

  const sessionsResponse = await fetchWithTimeout(
    `${base}/api/profiles/sessions?limit=200&order=recent`,
    headers,
    15_000,
  );
  const sessions: HermesRestSessionsResponse["sessions"] = sessionsResponse.ok
    ? ((await sessionsResponse.json()) as HermesRestSessionsResponse).sessions ?? []
    : [];

  const now = Date.now();
  const profiles: ProfileRecord[] = restProfiles.map((profile) => {
    const profileName = asTrimmedString(profile.name) || "default";
    const description = asTrimmedString(profile.description);
    const ownSessions = sessions
      .filter((session) => (asTrimmedString(session.profile) || "default") === profileName)
      .sort((a, b) => (b.ended_at ?? b.started_at ?? 0) - (a.ended_at ?? a.started_at ?? 0));
    const lastEndedAtMs = ownSessions[0]?.ended_at ?? ownSessions[0]?.started_at ?? null;
    // Display label: description part before "—" (rename flow), else title-cased name.
    const displayLabel = description.split("—")[0].trim() || titleCaseProfileName(profileName);
    return {
      agentId: profileName,
      name: displayLabel,
      emoji: profile.is_default === true ? "🤖" : "🧑‍💻",
      role: roleFromDescription(description),
      workspace: asTrimmedString(profile.path),
      model: asTrimmedString(profile.model),
      isDefault: profile.is_default === true,
      skills: typeof profile.skill_count === "number" ? profile.skill_count : 0,
      gatewayRunning: profile.gateway_running === true,
      lastActivityAt: lastEndedAtMs !== null ? Math.round(lastEndedAtMs * 1000) : null,
      sessions: ownSessions.length,
      recentSessions: ownSessions.slice(0, 5).map((session) => ({
        displayName: asTrimmedString(session.display_name) || asTrimmedString(session.id),
        startedAt:
          session.started_at !== null && session.started_at !== undefined
            ? Math.round(session.started_at * 1000)
            : null,
        messageCount: typeof session.message_count === "number" ? session.message_count : null,
        source: asTrimmedString(session.source) || null,
      })),
    };
  });

  return {
    workspaceId: "default",
    timestamp: new Date(now).toISOString(),
    connected: true,
    source: "hermes-rest",
    profiles,
  };
};

const loadProfilesViaGatewayFleet = async (params: {
  gatewayUrl: string;
  token: string;
}): Promise<ProfilesSnapshot> => {
  const gatewayClient = new NodeGatewayClient();
  try {
    await gatewayClient.connect({ gatewayUrl: params.gatewayUrl, token: params.token });
    const agentsResult = (await gatewayClient.request("agents.list", {})) as {
      defaultId?: string;
      mainKey?: string;
      agents?: Array<{
        id?: string;
        name?: string;
        identity?: { name?: string; emoji?: string };
        role?: string;
        model?: string;
      }>;
    };
    const mainSessionKeys = (agentsResult.agents ?? [])
      .map((agent) => asTrimmedString(agent.id))
      .filter(Boolean)
      .map((agentId) => buildAgentMainSessionKey(agentId, asTrimmedString(agentsResult.mainKey) || "main"));
    const previewSnapshot = mainSessionKeys.length
      ? ((await gatewayClient.request("sessions.preview", {
          keys: mainSessionKeys,
          limit: 8,
          maxChars: 240,
        })) as { previews?: Array<{ key?: string; items?: Array<{ role: string; text: string }> }> })
      : null;

    const now = Date.now();
    const profiles: ProfileRecord[] = (agentsResult.agents ?? []).flatMap((agent) => {
      const agentId = asTrimmedString(agent.id);
      if (!agentId) return [];
      const previewItems =
        previewSnapshot?.previews?.find(
          (entry) => entry.key === buildAgentMainSessionKey(agentId, asTrimmedString(agentsResult.mainKey) || "main"),
        )?.items ?? [];
      let lastMessage: { role: string; text: string } | null = null;
      for (let index = (previewItems?.length ?? 0) - 1; index >= 0; index -= 1) {
        const item = previewItems[index];
        if (item?.role === "assistant" || item?.role === "user") {
          lastMessage = { role: item.role, text: item.text };
          break;
        }
      }
      return [
        {
          agentId,
          name: asTrimmedString(agent.identity?.name) || asTrimmedString(agent.name) || agentId,
          emoji: asTrimmedString(agent.identity?.emoji) || (agentId === asTrimmedString(agentsResult.defaultId) ? "🤖" : "🧑‍💻"),
          role: asTrimmedString(agent.role),
          workspace: "",
          model: asTrimmedString(agent.model),
          isDefault: agentId === asTrimmedString(agentsResult.defaultId),
          skills: 0,
          gatewayRunning: true,
          lastActivityAt: null,
          sessions: 0,
          recentSessions: [],
          ...(lastMessage ? { lastMessage } : {}),
        },
      ];
    });
    return {
      workspaceId: "default",
      timestamp: new Date(now).toISOString(),
      connected: true,
      source: "gateway-fleet",
      profiles,
    };
  } finally {
    gatewayClient.close();
  }
};

export async function GET(request: Request) {
  const settings = loadStudioSettings();
  const gatewayUrl = asTrimmedString(settings.gateway?.url);
  if (!gatewayUrl) {
    return NextResponse.json({ error: "studio.gateway_url_missing" }, { status: 503 });
  }
  const token = asTrimmedString(settings.gateway?.token);

  // Scope: "all" bawaan master token; per-user scope dari access gate.
  const scopeHeader = asTrimmedString(request.headers.get("x-studio-user-scope")).toLowerCase();
  const userId = asTrimmedString(request.headers.get("x-studio-user-id"));
  const scopeNames = scopeHeader === "all" || !scopeHeader ? null : scopeHeader.split(",").map(s => s.trim()).filter(Boolean);

  const filterByScope = (snapshot: ProfilesSnapshot): ProfilesSnapshot => {
    if (!scopeNames) return snapshot;
    return {
      ...snapshot,
      viewerId: userId || null,
      profiles: snapshot.profiles.filter((profile) =>
        scopeNames.some((name) => name.toLowerCase() === profile.agentId.toLowerCase()),
      ),
    };
  };

  try {
    const snapshot = await loadProfilesViaHermesRest({
      baseUrl: restBaseUrlFromGatewayUrl(gatewayUrl),
      token,
    });
    return NextResponse.json(filterByScope(snapshot), { headers: { "Cache-Control": "no-store" } });
  } catch (restError) {
    const restMessage = restError instanceof Error ? restError.message : "hermes REST failed";
    console.warn("[profiles] Hermes REST unavailable, falling back to gateway fleet.", {
      restError: restMessage,
    });
  }

  try {
    const snapshot = await loadProfilesViaGatewayFleet({ gatewayUrl, token });
    return NextResponse.json(filterByScope(snapshot), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load profile roster.";
    console.error("[profiles] Failed to load profile roster.", { error: message });
    return NextResponse.json({ error: message }, { status: 502 });
  }
}