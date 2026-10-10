import { Container, getContainer } from "@cloudflare/containers";
export { UsageStats } from "./usage";

interface Env {
  APP: DurableObjectNamespace<App>;
  DOMAIN: string;
  BOT_TOKEN?: string; // a secret, uploaded by the deploy workflow
  ADMIN_TOKEN?: string;
  ANALYTICS_SALT?: string;
  USAGE: DurableObjectNamespace;
}

/**
 * The repo's Docker image, running the website with the Telegram bot inside
 * it (webhook mode: Telegram calls https://DOMAIN/telegram).
 */
export class App extends Container<Env> {
  defaultPort = 8000;
  // Stop after 30 quiet minutes; the next visitor or Telegram message starts it again.
  sleepAfter = "30m";
  entrypoint = [
    "uvicorn", "web:app", "--host", "0.0.0.0", "--port", "8000",
    "--proxy-headers", "--forwarded-allow-ips", "*",
  ];

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.envVars = {
      BOT_MODE: "webhook",
      BOT_TOKEN: env.BOT_TOKEN ?? "",
      DOMAIN: env.DOMAIN,
      ADMIN_TOKEN: env.ADMIN_TOKEN ?? "",
      ANALYTICS_SALT: env.ANALYTICS_SALT ?? "",
      ANALYTICS_URL: `https://${env.DOMAIN}/_usage`,
      ALLOWED_USERS: "",
    };
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (new URL(request.url).pathname === "/_usage") {
      if (!env.ADMIN_TOKEN || request.headers.get("Authorization") !== `Bearer ${env.ADMIN_TOKEN}`) {
        return new Response("Unauthorized", { status: 401 });
      }
      return env.USAGE.get(env.USAGE.idFromName("usage")).fetch(request);
    }
    // Tell the app who the visitor is (for its per-visitor download limit).
    const headers = new Headers(request.headers);
    headers.set("X-Forwarded-For", request.headers.get("CF-Connecting-IP") ?? "");
    headers.set("X-Forwarded-Proto", "https");
    return getContainer(env.APP).fetch(new Request(request, { headers }));
  },
} satisfies ExportedHandler<Env>;
