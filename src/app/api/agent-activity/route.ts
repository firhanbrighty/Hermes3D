import { NextResponse } from "next/server";
import { loadStudioSettings } from "@/lib/studio/settings-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const asTrimmedString = (value: unknown) =>
  typeof value === "string" ? value.trim() : "";

const resolveViewerScope = (request: Request) => {
  const header = asTrimmedString(request.headers.get("x-studio-user-scope")).toLowerCase();
  if (!header) return "all";
  if (header === "all" || header === "*") return "all";
  return header.split(",").map((entry) => entry.trim()).filter(Boolean);
};

const CONNECTION_TTL_MS = 15 * 60 * 1000;
const EVENTS_WS_PATH = "/api/events";
const DEFAULT_CHANNEL = "hermes3d";

const wsUrlFromRestBase = (restBase: string, token: string) => {
  const parsed = new URL(restBase.replace(/\/+$/, ""));
  parsed.protocol = parsed.protocol === "https:" ? "wss:" : "ws:";
  parsed.pathname = EVENTS_WS_PATH;
  parsed.search = `channel=${DEFAULT_CHANNEL}&token=${encodeURIComponent(token)}`;
  return parsed.toString();
};

const frameMentionsAgent = (text: string, agentId: string) => {
  if (!text) return false;
  const lower = text.toLowerCase();
  const target = agentId.toLowerCase();
  if (lower.includes(`"profile":"${target}"`)) return true;
  const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`, "i").test(text.slice(0, 2000));
};

/** CEO-only live activity: WebSocket→SSE bridge from the hermes events channel. */
export async function GET(request: Request) {
  if (resolveViewerScope(request) !== "all") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const settings = loadStudioSettings();
  const token = asTrimmedString(settings.gateway?.token);
  const gatewayUrl = asTrimmedString(settings.gateway?.url);
  if (!token || !gatewayUrl) {
    return NextResponse.json({ error: "studio.gateway_url_missing" }, { status: 503 });
  }
  const agentId = asTrimmedString(new URL(request.url).searchParams.get("agentId"));
  if (!agentId || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(agentId)) {
    return NextResponse.json({ error: "invalid_agent_id" }, { status: 400 });
  }

  const { WebSocket } = await import("ws");
  const encoder = new TextEncoder();
  let upstream: import("ws").WebSocket | null = null;
  const eventStream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const send = (event: string, data: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${data}\n\n`));
        } catch {
          closed = true;
        }
      };
      const finish = () => {
        if (!closed) {
          closed = true;
          try {
            upstream?.close();
          } catch {
            // already closed
          }
          try {
            controller.close();
          } catch {
            // already closed
          }
        }
      };
      const ttlTimer = setTimeout(finish, CONNECTION_TTL_MS);

      const wsUrl = wsUrlFromRestBase(gatewayUrl, token);
      const ws = new WebSocket(wsUrl, { headers: { Host: "localhost" } });
      upstream = ws;

      ws.on("open", () => {
        send("open", JSON.stringify({ ok: true, agentId }));
      });
      ws.on("message", (raw) => {
        const text = raw.toString().slice(0, 4000);
        if (!frameMentionsAgent(text, agentId)) return;
        send("activity", text);
      });
      ws.on("close", () => {
        clearTimeout(ttlTimer);
        send("end", JSON.stringify({ agentId }));
        finish();
      });
      ws.on("error", (err) => {
        clearTimeout(ttlTimer);
        send("error", JSON.stringify({ message: err.message }));
        finish();
      });

      request.signal.addEventListener("abort", () => {
        clearTimeout(ttlTimer);
        finish();
      });
    },
    cancel() {
      try {
        upstream?.close();
      } catch {
        // already closed
      }
    },
  });

  return new Response(eventStream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}