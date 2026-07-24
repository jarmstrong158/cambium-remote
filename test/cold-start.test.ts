// Cold start: a freshly deployed Worker pointed at an account with NO promoted
// knowledge yet.
//
// The one-click "Deploy to Cloudflare" flow drops a new Worker in front of
// repos that may have no cambium branch and no knowledge.json anywhere. That is
// the stateless analogue of "a cold, empty database", and it is the FIRST thing
// a self-hoster experiences. It must degrade to an honest empty answer -- never
// a crash, and never a confident-looking one.

import { afterEach, describe, expect, it, vi } from "vitest";
import { createMcpHandler } from "../src/mcp.js";
import { buildCtx, recall, status } from "../src/tools.js";
import type { Env } from "../src/types.js";
import { ENV, fakeGitHub } from "./helpers.js";

afterEach(() => vi.unstubAllGlobals());

const coldCtx = (over: Partial<Env> = {}) => buildCtx({ ...ENV, ...over } as Env);

describe("cold start: fresh deploy against an account with no knowledge", () => {
  it("recall abstains honestly rather than returning weak matches", async () => {
    // Nothing discovered, no org knowledge.json: every read 404s.
    const fake = fakeGitHub({ discovered: [], stores: {} });
    vi.stubGlobal("fetch", fake.fetch);

    const r: any = await recall(coldCtx(), { query: "how do we do deploys" });

    expect(r.results).toEqual([]);
    expect(r.no_confident_match).toBe(true);
    expect(r.guidance).toBeTruthy();
    // A cold store is a normal empty answer, not an error.
    expect(r.scope_errors).toBeUndefined();
  });

  it("status reports zero counts without throwing", async () => {
    const fake = fakeGitHub({ discovered: [], stores: {} });
    vi.stubGlobal("fetch", fake.fetch);

    const s: any = await status(coldCtx());
    expect(s.counts).toEqual({ team_repos: 0, team_active: 0, org_active: 0 });
    expect(s.server).toBe("cambium-remote");
  });

  it("the handshake never touches GitHub, so it answers on a cold isolate", async () => {
    // If initialize/tools-list blocked on a GitHub round-trip, a reconnecting
    // claude.ai client could time out before the Worker ever answered.
    const fake = fakeGitHub();
    vi.stubGlobal("fetch", fake.fetch);
    const handler = createMcpHandler();

    for (const method of ["initialize", "ping", "tools/list"]) {
      const res = await handler(
        new Request("https://w.example/mcp/secret", {
          method: "POST",
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: {} }),
        }),
        coldCtx(),
      );
      expect(res.status).toBe(200);
    }
    expect(fake.state.authHeaders).toEqual([]);
    expect(fake.state.graphqlCalls).toBe(0);
  });

  it("a repo the GH_PAT cannot see degrades visibly instead of silently", async () => {
    // The realistic misconfiguration: discovery (Metadata:Read) succeeds and
    // lists a private repo, but Contents:Read was not granted for it. Silent
    // partial blindness would be the worst outcome for a recall tool -- the
    // caller cannot tell "nothing matched" from "half the corpus was
    // unreachable".
    const fake = fakeGitHub({ discovered: ["team/visible"], stores: {} });
    const failing = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input.toString());
      if (url.pathname.includes("/contents/")) {
        return new Response("Forbidden", { status: 403 });
      }
      return fake.fetch(input, init);
    }) as unknown as typeof fetch;
    vi.stubGlobal("fetch", failing);

    // A distinct TEAM_OWNER: discovery is memoized per (owner, branch) for
    // TEAM_CACHE_TTL_MS in the isolate, and the isolate outlives a single test.
    const r: any = await recall(coldCtx({ TEAM_OWNER: "team-403" }), { query: "anything" });
    expect(r.scope_errors).toBeDefined();
    expect(Object.keys(r.scope_errors)).toContain("team:team/visible");
  });

  it("an unconfigured org repo simply contributes nothing", async () => {
    const fake = fakeGitHub({ discovered: [], stores: {} });
    vi.stubGlobal("fetch", fake.fetch);

    const s: any = await status(coldCtx({ ORG_REPO: "" }));
    expect(s.configured.org_repo).toBeNull();
    expect(s.counts.org_active).toBe(0);
  });
});
