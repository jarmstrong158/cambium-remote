// Minimal read-only GitHub REST client (plain fetch, no Octokit). cambium-remote
// only READS knowledge.json, so unlike the sibling agentsync-remote there is no
// contents-write / compare-and-swap here — just GET contents and default-branch
// lookup. The repo is passed explicitly per call because this Worker reads from
// several repos (the org knowledge repo + each team repo's cambium branch),
// unlike agentsync-remote's single coordination repo.

import type { Ctx } from "./types.js";

const API = "https://api.github.com";

/** Thrown when GH_PAT is not configured. Surfaced to the model as a clear,
 *  named tool error rather than a generic failure. */
export class GhPatMissingError extends Error {
  constructor() {
    super(
      "The GH_PAT secret is not set on this Worker. Add a fine-grained GitHub " +
        "token (Metadata: Read + Contents: Read across your repos, so team scope " +
        "can auto-discover them) in the Cloudflare dashboard: Workers & Pages -> " +
        "cambium-remote -> Settings -> Variables and Secrets.",
    );
    this.name = "GhPatMissingError";
  }
}

function ghHeaders(ctx: Ctx): Record<string, string> {
  if (!ctx.env.GH_PAT) throw new GhPatMissingError();
  return {
    Authorization: `Bearer ${ctx.env.GH_PAT}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "cambium-remote",
  };
}

// UTF-8-safe base64 decode (GitHub contents are base64 of the raw file bytes).
export function b64decode(b64: string): string {
  const bin = atob(b64.replace(/\s/g, ""));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function contentsUrl(repo: string, path: string): string {
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  return `${API}/repos/${repo}/contents/${encoded}`;
}

/** GET a file's decoded content, or null if the file/branch/repo is not found
 *  (404). A 404 is a normal "nothing here yet", not an error. */
export async function getContent(
  ctx: Ctx,
  repo: string,
  path: string,
  ref: string,
): Promise<string | null> {
  const url = `${contentsUrl(repo, path)}?ref=${encodeURIComponent(ref)}`;
  const res = await fetch(url, { headers: ghHeaders(ctx) });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(
      `GitHub GET contents failed for ${repo}@${ref} (${res.status}): ${await res.text()}`,
    );
  }
  const json = (await res.json()) as { content: string };
  return b64decode(json.content);
}

/** The repository's default branch name (org scope reads its default branch). */
export async function getDefaultBranch(ctx: Ctx, repo: string): Promise<string> {
  const res = await fetch(`${API}/repos/${repo}`, { headers: ghHeaders(ctx) });
  if (!res.ok) {
    throw new Error(`GitHub GET repo failed for ${repo} (${res.status}): ${await res.text()}`);
  }
  const json = (await res.json()) as { default_branch: string };
  return json.default_branch;
}

// --------------------------------------------------------------------------
// Team-repo discovery (GraphQL). Team scope is a GROWING set — every repo that
// has been team-promoted gets a `cambium` branch — so the Worker discovers them
// instead of reading a frozen list. One GraphQL query returns each of the
// owner's repos together with whether it has the branch, so a scan is a single
// round-trip per 100 repos, not N REST calls.
// --------------------------------------------------------------------------

const GRAPHQL = "https://api.github.com/graphql";

const DISCOVERY_QUERY = `
query($owner:String!, $branch:String!, $after:String) {
  repositoryOwner(login:$owner) {
    repositories(first:100, after:$after, ownerAffiliations:OWNER) {
      pageInfo { hasNextPage endCursor }
      nodes { nameWithOwner ref(qualifiedName:$branch) { id } }
    }
  }
}`;

interface DiscoveryPage {
  repositoryOwner: {
    repositories: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: Array<{ nameWithOwner: string; ref: { id: string } | null }>;
    };
  } | null;
}

/** Every repo owned by `owner` that has a `branch` head — i.e. has team
 *  knowledge. Paginated; safety-capped at 2000 repos. */
export async function discoverTeamRepos(
  ctx: Ctx,
  owner: string,
  branch: string,
): Promise<string[]> {
  const qualified = `refs/heads/${branch}`;
  const out: string[] = [];
  let after: string | null = null;
  for (let page = 0; page < 20; page++) {
    const res = await fetch(GRAPHQL, {
      method: "POST",
      headers: { ...ghHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({ query: DISCOVERY_QUERY, variables: { owner, branch: qualified, after } }),
    });
    if (!res.ok) {
      throw new Error(`GitHub GraphQL failed (${res.status}): ${await res.text()}`);
    }
    const body = (await res.json()) as { data?: DiscoveryPage; errors?: unknown };
    if (body.errors) {
      throw new Error(`GitHub GraphQL errors: ${JSON.stringify(body.errors)}`);
    }
    const conn = body.data?.repositoryOwner?.repositories;
    if (!conn) break;
    for (const n of conn.nodes || []) {
      if (n?.ref && n.nameWithOwner) out.push(n.nameWithOwner);
    }
    if (!conn.pageInfo?.hasNextPage) break;
    after = conn.pageInfo.endCursor;
  }
  return out;
}
