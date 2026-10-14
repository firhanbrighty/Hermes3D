import { NextResponse } from "next/server";
import { readFile, writeFile, chmod, mkdir } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { loadStudioSettings } from "@/lib/studio/settings-store";

export const runtime = "nodejs";

const asTrimmedString = (value: unknown) =>
  typeof value === "string" ? value.trim() : "";

type UserRecord = {
  id: string;
  label: string;
  token: string;
  scope: "all" | string[];
};

type UsersFile = { users: UserRecord[] };

const registryPath = () => {
  const base = process.env.HERMES_STATE_DIR?.trim() || homedir();
  return path.resolve(`${base.replace(/\/+$/, "")}/.hermes/hermes3d/users.json`);
};

const slugify = (value: string) =>
  value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);

const resolveViewerScope = (request: Request) => {
  const header = asTrimmedString(request.headers.get("x-studio-user-scope")).toLowerCase();
  if (!header) return "all"; // legacy single-token deployment: master sees all
  if (header === "all" || header === "*") return "all";
  return header.split(",").map((entry) => entry.trim()).filter(Boolean);
};

/** CEO-only: read the manager token (if any) for one agent. */
export async function GET(request: Request) {
  if (resolveViewerScope(request) !== "all") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  let data: UsersFile = { users: [] };
  try {
    data = JSON.parse(await readFile(registryPath(), "utf8")) as UsersFile;
  } catch {
    return NextResponse.json({ exists: false });
  }
  const agentId = asTrimmedString(new URL(request.url).searchParams.get("agentId"));
  if (!agentId) {
    return NextResponse.json({ error: "invalid_agent_id" }, { status: 400 });
  }
  const user = (data.users ?? []).find(
    (entry) =>
      Array.isArray(entry.scope) &&
      entry.scope.some((name) => String(name).toLowerCase() === agentId.toLowerCase()),
  );
  if (!user) {
    return NextResponse.json({ exists: false, agentId });
  }
  return NextResponse.json({
    exists: true,
    agentId,
    userId: user.id,
    label: user.label,
    token: user.token,
  });
}

export async function POST(request: Request) {
  const settings = loadStudioSettings();
  const gatewayToken = asTrimmedString(settings.gateway?.token);
  const gatewayUrl = asTrimmedString(settings.gateway?.url);
  if (!gatewayToken || !gatewayUrl) {
    return NextResponse.json({ error: "studio.gateway_url_missing" }, { status: 503 });
  }

  let body: { agentId?: string; label?: string };
  try {
    body = (await request.json()) as { agentId?: string; label?: string };
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const agentId = asTrimmedString(body.agentId);
  if (!agentId || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(agentId)) {
    return NextResponse.json({ error: "invalid_agent_id" }, { status: 400 });
  }

  const filePath = registryPath();
  let data: UsersFile = { users: [] };
  try {
    data = JSON.parse(await readFile(filePath, "utf8")) as UsersFile;
    if (!Array.isArray(data.users)) data = { users: [] };
  } catch {
    data = { users: [] };
  }

  const userId = `mgr-${slugify(agentId)}`;
  const existing = data.users.find((user) => user.id === userId);
  if (existing && asTrimmedString(existing.token)) {
    return NextResponse.json({ ok: true, userId, token: existing.token, reused: true });
  }

  const token = randomBytes(16).toString("hex");
  data.users = [
    ...data.users.filter((user) => user.id !== userId),
    { id: userId, label: asTrimmedString(body.label) || agentId, token, scope: [agentId] },
  ];

  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await chmod(filePath, 0o600);

  return NextResponse.json({ ok: true, userId, token, reused: false });
}