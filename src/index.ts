// Worker entry point.
//
// Routing: POST /mcp/:token. The path token is checked against the AUTH_TOKEN
// secret. The server fails CLOSED: if AUTH_TOKEN is unset, or the token does not
// match, we return a bare 404 with no detail — an unconfigured or wrongly
// addressed endpoint is indistinguishable from a nonexistent one.
//
// GH_PAT is NOT checked here; a missing GH_PAT surfaces as a clear, named
// tool-level error only once an authenticated caller invokes a tool that reads
// GitHub. Kept in sync with the sibling agentsync-remote / context-keeper-remote
// Workers.

import { createMcpHandler } from "./mcp.js";
import { log } from "./log.js";
import { buildCtx } from "./tools.js";
import type { Env } from "./types.js";

const handleMcp = createMcpHandler();

const NOT_FOUND = () => new Response("Not Found", { status: 404 });

// Length-invariant comparison to avoid timing side channels on the token.
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const match = url.pathname.match(/^\/mcp\/([^/]+)\/?$/);

    // The path token is the credential -> log the route with it redacted.
    log("request", { route: match ? "/mcp/***" : url.pathname, method: request.method });

    if (!match) return NOT_FOUND();

    const token = match[1];
    const ok = !!env.AUTH_TOKEN && safeEqual(token, env.AUTH_TOKEN);
    log("auth", { ok });
    if (!ok) return NOT_FOUND();

    try {
      const ctx = buildCtx(env);
      return await handleMcp(request, ctx);
    } catch (e) {
      log("error", { message: e instanceof Error ? e.message : String(e) });
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32603, message: "Internal error" } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
  },
} satisfies ExportedHandler<Env>;
