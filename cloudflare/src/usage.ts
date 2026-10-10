import { DurableObject } from "cloudflare:workers";

/** Usage survives container restarts: it lives in Durable Object SQLite. */
export class UsageStats extends DurableObject {
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY, source TEXT NOT NULL, actor TEXT NOT NULL,
      kind TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS usage_window ON events(at,source,kind);
      CREATE TABLE IF NOT EXISTS installations (actor TEXT PRIMARY KEY, active INTEGER NOT NULL);`);
  }

  async fetch(request: Request): Promise<Response> {
    const sql = this.ctx.storage.sql;
    if (request.method === "POST") {
      const event = await request.json() as Record<string, unknown>;
      if (typeof event.id !== "string" || event.id.length > 100 ||
          typeof event.actor !== "string" || !/^[a-f0-9]{64}$/.test(event.actor) ||
          !["web", "telegram"].includes(String(event.source)) ||
          !["activity", "visit", "start", "request", "completed", "failed", "installed", "removed"].includes(String(event.kind))) {
        return new Response("Invalid event", { status: 400 });
      }
      this.ctx.storage.transactionSync(() => {
        const exists = sql.exec("SELECT id FROM events WHERE id=?", event.id as string).toArray().length;
        if (exists) return;
        sql.exec("INSERT INTO events VALUES (?,?,?,?,?)", event.id as string,
          event.source as string, event.actor as string, event.kind as string, Math.floor(Date.now()/1000));
        if (event.kind === "installed" || event.kind === "removed") {
          sql.exec("INSERT INTO installations VALUES (?,?) ON CONFLICT(actor) DO UPDATE SET active=excluded.active",
            event.actor as string, event.kind === "installed" ? 1 : 0);
        }
      });
      return Response.json({ ok: true });
    }
    if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
    const scalar = (query: string, ...args: (string | number)[]) => sql.exec(query, ...args).one().n as number;
    const now = Math.floor(Date.now()/1000);
    const result: Record<string, any> = {};
    for (const source of ["telegram", "web"]) {
      const count = (kind: string) => scalar("SELECT COUNT(*) AS n FROM events WHERE source=? AND kind=?", source, kind);
      result[source] = {
        total_users: scalar("SELECT COUNT(DISTINCT actor) AS n FROM events WHERE source=? AND kind='activity'", source),
        active_24h: scalar("SELECT COUNT(DISTINCT actor) AS n FROM events WHERE source=? AND kind='activity' AND at>=?", source, now-86400),
        active_30d: scalar("SELECT COUNT(DISTINCT actor) AS n FROM events WHERE source=? AND kind='activity' AND at>=?", source, now-30*86400),
        requests: count("request"), completed: count("completed"), failed: count("failed"),
      };
    }
    result.web.visitors = scalar("SELECT COUNT(DISTINCT actor) AS n FROM events WHERE source='web' AND kind='visit'");
    result.telegram.starts = scalar("SELECT COUNT(DISTINCT actor) AS n FROM events WHERE source='telegram' AND kind='start'");
    result.telegram.active_groups_channels = scalar("SELECT COUNT(*) AS n FROM installations WHERE active=1");
    result.recording_since = sql.exec("SELECT MIN(at) AS at FROM events").one().at;
    result.subscription = { threshold: 10000, basis: "telegram_active_30d",
      ready_for_review: result.telegram.active_30d >= 10000, monthly_price_gbp: 1,
      illustrative_gross_gbp: result.telegram.active_30d, billing_enabled: false };
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  }
}
