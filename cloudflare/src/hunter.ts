import { Container, getContainer } from "@cloudflare/containers";

interface Env {
  HUNTER: DurableObjectNamespace<Hunter>;
  DOMAIN: string;
  // Secrets, uploaded by .github/workflows/deploy-hunter.yml: HUNTER_CRON_SECRET, the
  // LITESTREAM_* R2 credentials, and whatever HUNTER_ENV holds (Keepa, Apify, Zarinpal...).
  HUNTER_CRON_SECRET?: string;
  [name: string]: unknown;
}

// Settings the container gets from the Worker's vars and secrets.
const PASSED = /^(HUNTER|KEEPA|APIFY|ZARINPAL|ANTHROPIC|LITESTREAM)_[A-Z0-9_]+$/;

/** The hunter's Docker image: the sellers' website on port 8100. */
export class Hunter extends Container<Env> {
  defaultPort = 8100;
  // Sleep after 2 quiet hours (long enough for a daily hunt to finish); the next visitor
  // starts it again, with the database brought back from R2.
  sleepAfter = "2h";

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const vars: Record<string, string> = {
      HUNTER_PUBLIC_URL: `https://${env.DOMAIN}`,
      FORWARDED_ALLOW_IPS: "*", // the visitor's address comes from the Worker below
    };
    for (const [name, value] of Object.entries(env)) {
      if (PASSED.test(name) && typeof value === "string" && value) vars[name] = value;
    }
    this.envVars = vars;
  }
}

function startHunt(env: Env): Promise<Response> {
  return getContainer(env.HUNTER).fetch(
    new Request(`https://${env.DOMAIN}/internal/hunt`, {
      method: "POST",
      headers: { "X-Hunter-Cron": env.HUNTER_CRON_SECRET ?? "" },
    }),
  );
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    // /internal/* is for the cron below (and the deploy workflow, which knows the secret).
    if (url.pathname.startsWith("/internal/")) {
      const secret = env.HUNTER_CRON_SECRET;
      if (!secret || request.headers.get("X-Hunter-Cron") !== secret) {
        return new Response("Not Found", { status: 404 });
      }
    }
    // Tell the app who the visitor is (login throttling) and that the page is https.
    const headers = new Headers(request.headers);
    headers.set("X-Forwarded-For", request.headers.get("CF-Connecting-IP") ?? "");
    headers.set("X-Forwarded-Proto", "https");
    return getContainer(env.HUNTER).fetch(new Request(request, { headers }));
  },

  // The daily hunt (wrangler "triggers"): wakes the container and starts it there.
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(startHunt(env).then((r) => console.log("daily hunt:", r.status)));
  },
} satisfies ExportedHandler<Env>;
