import { Database } from "bun:sqlite";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";

const PORT = Number(process.env.PORT ?? 47391);
const INTERVAL_MIN = Math.max(5, Number(process.env.COLLECT_INTERVAL_MIN ?? 15));
const DB_PATH = process.env.DB_PATH ?? "./data/analytics.db";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "";
const SESSION_SECRET = process.env.SESSION_SECRET || randomBytes(32).toString("hex");
const COOKIE_NAME = "dc_auth";

mkdirSync(DB_PATH.substring(0, DB_PATH.lastIndexOf("/")) || "./data", { recursive: true });

const db = new Database(DB_PATH, { create: true });
db.exec("PRAGMA journal_mode = WAL;");
db.exec(`
  CREATE TABLE IF NOT EXISTS servers (
    invite_code TEXT PRIMARY KEY,
    guild_id TEXT,
    name TEXT NOT NULL,
    icon_url TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    invite_code TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    total_members INTEGER NOT NULL,
    online_members INTEGER NOT NULL,
    FOREIGN KEY (invite_code) REFERENCES servers(invite_code) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_snapshots_code_ts ON snapshots(invite_code, timestamp);
`);

export function extractInviteCode(input: string): string {
  const cleaned = input.trim().replace(/\/+$/, "");
  const match = cleaned.match(/(?:discord\.gg|discord\.com\/invite)\/([a-zA-Z0-9-]+)$/i);
  return match ? match[1] : cleaned;
}

async function fetchDiscordInvite(code: string) {
  const res = await fetch(`https://discord.com/api/v10/invites/${encodeURIComponent(code)}?with_counts=true`, {
    headers: { "User-Agent": "DC-Analytics/1.0" },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message ?? `Discord API error (${res.status})`);
  }
  const data = await res.json();
  if (!data.guild || typeof data.approximate_member_count !== "number") {
    throw new Error("Invalid invite response from Discord");
  }
  const iconUrl = data.guild.icon
    ? `https://cdn.discordapp.com/icons/${data.guild.id}/${data.guild.icon}.png?size=64`
    : null;
  return {
    invite_code: code,
    guild_id: String(data.guild.id),
    name: String(data.guild.name),
    icon_url: iconUrl,
    total_members: Number(data.approximate_member_count),
    online_members: Number(data.approximate_presence_count ?? 0),
  };
}

async function collectOne(code: string) {
  const stats = await fetchDiscordInvite(code);
  const now = new Date().toISOString();

  db.query(`
    INSERT INTO servers (invite_code, guild_id, name, icon_url, created_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(invite_code) DO UPDATE SET
      guild_id = excluded.guild_id,
      name = excluded.name,
      icon_url = excluded.icon_url
  `).run(stats.invite_code, stats.guild_id, stats.name, stats.icon_url, now);

  db.query(`
    INSERT INTO snapshots (invite_code, timestamp, total_members, online_members)
    VALUES (?, ?, ?, ?)
  `).run(stats.invite_code, now, stats.total_members, stats.online_members);

  return { ...stats, timestamp: now };
}

async function collectAll() {
  const rows = db.query("SELECT invite_code FROM servers").all() as { invite_code: string }[];
  const results = [];
  const errors: string[] = [];
  for (const { invite_code } of rows) {
    try {
      results.push(await collectOne(invite_code));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[collector] Failed for ${invite_code}:`, msg);
      errors.push(`${invite_code}: ${msg}`);
    }
  }
  return { results, errors };
}

// Seed optional INVITE_CODES env var on startup (comma-separated)
const initialCodes = (process.env.INVITE_CODES ?? "")
  .split(",")
  .map((s) => extractInviteCode(s))
  .filter(Boolean);

for (const code of initialCodes) {
  collectOne(code).catch((err) => console.error(`[seed] Failed for ${code}:`, err));
}

setInterval(() => {
  collectAll().catch((err) => console.error("[scheduler] Error:", err));
}, INTERVAL_MIN * 60 * 1000);

const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });

function signToken(exp: number): string {
  const payload = String(exp);
  const sig = createHmac("sha256", SESSION_SECRET).update(payload).digest("hex");
  return `${payload}.${sig}`;
}

function verifyToken(token: string | undefined): boolean {
  if (!token || !ADMIN_PASSWORD) return false;
  const [payload, sig] = token.split(".");
  if (!payload || !sig || Number(payload) < Date.now()) return false;
  const expected = createHmac("sha256", SESSION_SECRET).update(payload).digest("hex");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function getCookie(req: Request, name: string): string | undefined {
  const header = req.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

function verifyPassword(input: string): boolean {
  if (!ADMIN_PASSWORD) return false;
  const a = createHmac("sha256", SESSION_SECRET).update(input).digest();
  const b = createHmac("sha256", SESSION_SECRET).update(ADMIN_PASSWORD).digest();
  return timingSafeEqual(a, b);
}

function requireAuth(req: Request): Response | null {
  if (!ADMIN_PASSWORD) return json({ error: "ADMIN_PASSWORD not set in .env" }, 503);
  if (!verifyToken(getCookie(req, COOKIE_NAME))) return json({ error: "Unauthorized" }, 401);
  return null;
}

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const { pathname } = url;

    if (pathname === "/" && req.method === "GET") {
      return new Response(Bun.file("./public/index.html"), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    if (pathname === "/api/auth" && req.method === "GET") {
      return json({
        configured: Boolean(ADMIN_PASSWORD),
        authenticated: verifyToken(getCookie(req, COOKIE_NAME)),
      });
    }

    if (pathname === "/api/auth" && req.method === "POST") {
      if (!ADMIN_PASSWORD) return json({ error: "ADMIN_PASSWORD not set in .env" }, 503);
      const body = await req.json().catch(() => ({}));
      if (!verifyPassword(String(body.password ?? ""))) {
        return json({ error: "Invalid password" }, 401);
      }
      const maxAge = 60 * 60 * 24 * 7;
      const token = signToken(Date.now() + maxAge * 1000);
      return json(
        { authenticated: true },
        200,
        { "Set-Cookie": `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}` }
      );
    }

    if (pathname === "/api/auth" && req.method === "DELETE") {
      return json(
        { authenticated: false },
        200,
        { "Set-Cookie": `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0` }
      );
    }

    if (pathname === "/api/servers" && req.method === "GET") {
      const servers = db.query(`
        SELECT s.*,
          (SELECT total_members FROM snapshots WHERE invite_code = s.invite_code ORDER BY timestamp DESC LIMIT 1) AS total_members,
          (SELECT online_members FROM snapshots WHERE invite_code = s.invite_code ORDER BY timestamp DESC LIMIT 1) AS online_members,
          (SELECT timestamp FROM snapshots WHERE invite_code = s.invite_code ORDER BY timestamp DESC LIMIT 1) AS last_updated
        FROM servers s
        ORDER BY s.created_at ASC
      `).all();
      return json(servers);
    }

    if (pathname === "/api/servers" && req.method === "POST") {
      const denied = requireAuth(req);
      if (denied) return denied;
      try {
        const body = await req.json();
        const code = extractInviteCode(String(body.invite ?? ""));
        if (!code) return json({ error: "Invite code is required" }, 400);
        const result = await collectOne(code);
        return json(result, 201);
      } catch (err) {
        return json({ error: err instanceof Error ? err.message : "Failed to add server" }, 400);
      }
    }

    if (pathname.startsWith("/api/servers/") && req.method === "DELETE") {
      const denied = requireAuth(req);
      if (denied) return denied;
      const code = decodeURIComponent(pathname.slice("/api/servers/".length));
      db.query("DELETE FROM snapshots WHERE invite_code = ?").run(code);
      db.query("DELETE FROM servers WHERE invite_code = ?").run(code);
      return json({ ok: true });
    }

    if (pathname.startsWith("/api/stats/") && req.method === "GET") {
      const code = decodeURIComponent(pathname.slice("/api/stats/".length));
      const hours = Number(url.searchParams.get("hours") ?? 24);
      const rows = hours > 0
        ? db.query(`
            SELECT timestamp, total_members, online_members
            FROM snapshots
            WHERE invite_code = ? AND timestamp >= ?
            ORDER BY timestamp ASC
          `).all(code, new Date(Date.now() - hours * 3600_000).toISOString())
        : db.query(`
            SELECT timestamp, total_members, online_members
            FROM snapshots
            WHERE invite_code = ?
            ORDER BY timestamp ASC
          `).all(code);
      return json(rows);
    }

    if (pathname === "/api/collect" && req.method === "POST") {
      const denied = requireAuth(req);
      if (denied) return denied;
      const { results, errors } = await collectAll();
      if (results.length === 0 && errors.length > 0) {
        return json({ error: errors[0], errors }, 502);
      }
      return json({ collected: results.length, results, errors });
    }

    return json({ error: "Not found" }, 404);
  },
});

console.log(`DC-Analytics running on http://localhost:${server.port} (interval: ${INTERVAL_MIN}m)`);

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    db.close();
    server.stop();
    process.exit(0);
  });
}
