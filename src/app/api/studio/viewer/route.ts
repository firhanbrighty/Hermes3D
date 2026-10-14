import { NextResponse } from "next/server";

export const runtime = "nodejs";

/**
 * Expose the viewer's identity to the client UI (scope only — no secrets).
 * Values come from the access gate via x-studio-user-* headers set by the
 * Studio server on every request.
 */

const asTrimmedString = (value: unknown) =>
  typeof value === "string" ? value.trim() : "";

export async function GET(request: Request) {
  const scopeHeader = asTrimmedString(request.headers.get("x-studio-user-scope")).toLowerCase();
  const userId = asTrimmedString(request.headers.get("x-studio-user-id"));
  const isLegacyMaster = !scopeHeader;
  const scope = isLegacyMaster || scopeHeader === "all" || scopeHeader === "*" ? "all" : scopeHeader;
  return NextResponse.json(
    { userId: userId || (isLegacyMaster ? "master" : ""), scope },
    { headers: { "Cache-Control": "no-store" } },
  );
}