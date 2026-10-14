import { NextResponse } from "next/server";
import { loadStudioSettings } from "@/lib/studio/settings-store";
import { NodeGatewayClient } from "@/lib/gateway/nodeGatewayClient";

export const runtime = "nodejs";

const asTrimmedString = (value: unknown) =>
  typeof value === "string" ? value.trim() : "";

const restBaseUrlFromGatewayUrl = (gatewayUrl: string) => {
  if (gatewayUrl.startsWith("http://") || gatewayUrl.startsWith("https://")) return gatewayUrl;
  return gatewayUrl.replace(/^wss:/, "https:").replace(/^ws:/, "http:");
};

const fetchWithTimeout = async (url: string, init: RequestInit, timeoutMs: number) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal, cache: "no-store" });
  } finally {
    clearTimeout(timer);
  }
};

type CreateProfileRequest = {
  name?: string;
  description?: string;
};

/**
 * Create a hermes profile via the hermes-agent REST API
 * (`POST /api/profiles`). Used by the wizard's agents.create step on
 * backends that predate the fleet `agents.create` RPC.
 */
export async function POST(request: Request) {
  const settings = loadStudioSettings();
  const gatewayUrl = asTrimmedString(settings.gateway?.url);
  const token = asTrimmedString(settings.gateway?.token);
  if (!gatewayUrl || !token) {
    return NextResponse.json({ error: "studio.gateway_url_missing" }, { status: 503 });
  }

  let body: CreateProfileRequest;
  try {
    body = (await request.json()) as CreateProfileRequest;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const name = asTrimmedString(body.name);
  if (!name || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(name)) {
    return NextResponse.json({ error: "invalid_name" }, { status: 400 });
  }
  const description = asTrimmedString(body.description).slice(0, 500);

  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  const base = restBaseUrlFromGatewayUrl(gatewayUrl).replace(/\/+$/, "");

  try {
    const response = await fetchWithTimeout(`${base}/api/profiles`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name, description: description || undefined, no_skills: false }),
    }, 30_000);
    const payload = (await response.json().catch(() => null)) as {
      ok?: boolean; name?: string; path?: string; detail?: string;
    } | null;
    if (!response.ok) {
      const detail = payload?.detail ?? `HTTP ${response.status}`;
      return NextResponse.json({ error: detail }, { status: response.status === 400 ? 400 : 502 });
    }
    if (!payload?.ok) {
      return NextResponse.json({ error: "profile_create_failed" }, { status: 502 });
    }
    return NextResponse.json({
      ok: true,
      agentId: payload.name ?? name,
      name,
      workspace: payload.path ?? "",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "profile create failed";
    console.error("[gateway/agent-create] profile create failed.", { error: message });
    return NextResponse.json({ error: message }, { status: 502 });
  }
}

/**
 * Probe: does the connected gateway speak the fleet `agents.create` RPC?
 * The wizard checks this first and only falls back to the profile REST path
 * when the RPC is missing (hermes-agent pre-fleet backends).
 */
export async function GET() {
  const settings = loadStudioSettings();
  const gatewayUrl = asTrimmedString(settings.gateway?.url);
  const token = asTrimmedString(settings.gateway?.token);
  if (!gatewayUrl || !token) {
    return NextResponse.json({ mode: "unavailable", error: "studio.gateway_url_missing" }, { status: 503 });
  }
  const gatewayClient = new NodeGatewayClient();
  try {
    await gatewayClient.connect({ gatewayUrl, token });
    const methodsResult = (await gatewayClient.request("status", {})) as {
      features?: { methods?: string[] };
    };
    const methods = methodsResult?.features?.methods ?? [];
    return NextResponse.json({ mode: methods.includes("agents.create") ? "fleet" : "profile-rest" });
  } catch {
    return NextResponse.json({ mode: "profile-rest" });
  } finally {
    gatewayClient.close();
  }
}