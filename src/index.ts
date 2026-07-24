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
import { pathTokenMatches } from "./shared/mcp-core.js";
import { buildCtx } from "./tools.js";
import type { Env } from "./types.js";

const handleMcp = createMcpHandler();

const NOT_FOUND = () => new Response("Not Found", { status: 404 });

// Token comparison lives in src/shared/mcp-core.ts (pathTokenMatches), shared
// byte-identically with context-keeper-remote and agentsync-remote. The three
// local copies it replaces all claimed to be kept in sync and all behaved
// differently: this one never percent-decoded the path segment, and all three
// early-returned on a length mismatch, leaking the token's length. That matters
// most here -- this Worker holds the broadest GH_PAT of the three.

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const match = url.pathname.match(/^\/mcp\/([^/]+)\/?$/);

    // The path token is the credential -> log the route with it redacted.
    log("request", { route: match ? "/mcp/***" : url.pathname, method: request.method });

    if (!match) return NOT_FOUND();

    // Fail closed: unset AUTH_TOKEN or a mismatched token -> 404, no detail.
    const ok = await pathTokenMatches(match[1], env.AUTH_TOKEN);
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
