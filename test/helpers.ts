// An in-memory fake of the GitHub REST + GraphQL endpoints cambium-remote
// reads. No network. Wire it in with `vi.stubGlobal("fetch", fake.fetch)`.
//
// Unlike test/recall.test.ts (which vi.mocks src/github.js and therefore never
// exercises it), this fake stubs `fetch` itself, so the real github.ts client
// -- including its GH_PAT check -- runs. That is the point: the auth boundary
// is what these tests exist to cover.

import type { Env, KnowledgeItem } from "../src/types.js";

export interface FakeOpts {
  /** "owner/name|ref" -> the knowledge.json items at that ref. */
  stores?: Record<string, KnowledgeItem[]>;
  /** Repos discoverTeamRepos() should report as having a cambium branch. */
  discovered?: string[];
  defaultBranch?: string;
}

export interface FakeState {
  contentGets: string[];
  graphqlCalls: number;
  /** Authorization headers seen, so tests can assert the PAT is actually used. */
  authHeaders: string[];
}

export function fakeGitHub(opts: FakeOpts = {}) {
  const stores = opts.stores ?? {};
  const discovered = opts.discovered ?? [];
  const defaultBranch = opts.defaultBranch ?? "main";

  const state: FakeState = { contentGets: [], graphqlCalls: 0, authHeaders: [] };

  const jsonRes = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });

  const b64encode = (s: string) => {
    const bytes = new TextEncoder().encode(s);
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin);
  };

  const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const headers = new Headers(init.headers as HeadersInit | undefined);
    const auth = headers.get("Authorization");
    if (auth) state.authHeaders.push(auth);

    if (url.hostname === "api.github.com" && url.pathname === "/graphql") {
      state.graphqlCalls++;
      return jsonRes(200, {
        data: {
          repositoryOwner: {
            repositories: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: discovered.map((nameWithOwner) => ({ nameWithOwner, ref: { id: "r" } })),
            },
          },
        },
      });
    }

    const parts = url.pathname.split("/").filter(Boolean); // repos/owner/name/...
    const repo = `${parts[1]}/${parts[2]}`;
    const rest = parts.slice(3);

    // GET /repos/{owner}/{repo}
    if (rest.length === 0) return jsonRes(200, { default_branch: defaultBranch });

    // GET /repos/{owner}/{repo}/contents/{path}
    if (rest[0] === "contents") {
      const ref = url.searchParams.get("ref") ?? "";
      state.contentGets.push(`${repo}|${ref}`);
      const items = stores[`${repo}|${ref}`];
      if (!items) return jsonRes(404, { message: "Not Found" });
      return jsonRes(200, { content: b64encode(JSON.stringify({ items })) });
    }

    return jsonRes(404, { message: `Unhandled ${url.pathname}` });
  }) as unknown as typeof fetch;

  return { fetch: fetchImpl, state };
}

export const ENV: Env = {
  AUTH_TOKEN: "secret",
  GH_PAT: "ghp_test",
  ORG_REPO: "org/knowledge",
  TEAM_OWNER: "team",
  TEAM_BRANCH: "cambium",
  KNOWLEDGE_PATH: "knowledge.json",
};

export function post(token: string, body: unknown): Request {
  return new Request(`https://w.example/mcp/${token}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
