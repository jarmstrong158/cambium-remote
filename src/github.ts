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
        "token (Contents: Read, scoped to your org knowledge repo and any team " +
        "repos) in the Cloudflare dashboard: Workers & Pages -> cambium-remote " +
        "-> Settings -> Variables and Secrets.",
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
