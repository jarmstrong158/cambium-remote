// cambium-remote tools: read-only recall over team + org knowledge, plus a
// status probe. No writes: recall does NOT increment recall counters (that would
// be a CAS write to the shared branch), which also means mobile recalls do not
// feed promotion — consistent with local cambium not tracking org-scope usage.

import { discoverTeamRepos, getContent, getDefaultBranch } from "./github.js";
import { RELEVANCE_FLOOR, score, tokens } from "./score.js";
import type { Ctx, Env, KnowledgeItem } from "./types.js";

export function buildCtx(env: Env): Ctx {
  return {
    env,
    orgRepo: (env.ORG_REPO || "").trim(),
    teamOwner: (env.TEAM_OWNER || "").trim(),
    teamRepos: (env.TEAM_REPOS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    teamBranch: (env.TEAM_BRANCH || "cambium").trim(),
    knowledgePath: (env.KNOWLEDGE_PATH || "knowledge.json").trim(),
    now: () => new Date().toISOString(),
  };
}

// Team scope is a GROWING set, so we discover it (see github.discoverTeamRepos)
// rather than read a static list. Discovery is cached per (owner, branch) in the
// isolate for a few minutes so a burst of recalls costs one scan, and a newly
// team-promoted repo shows up within the TTL — no redeploy, no config edit.
const TEAM_CACHE_TTL_MS = 5 * 60 * 1000;
const teamRepoCache = new Map<string, { at: number; repos: string[] }>();

/** The full team-repo set for this ctx: auto-discovered under TEAM_OWNER, plus
 *  any explicit TEAM_REPOS extras, deduped. */
async function resolveTeamRepos(ctx: Ctx): Promise<string[]> {
  let discovered: string[] = [];
  if (ctx.teamOwner) {
    const key = `${ctx.teamOwner}|${ctx.teamBranch}`;
    const hit = teamRepoCache.get(key);
    const now = Date.now();
    if (hit && now - hit.at < TEAM_CACHE_TTL_MS) {
      discovered = hit.repos;
    } else {
      discovered = await discoverTeamRepos(ctx, ctx.teamOwner, ctx.teamBranch);
      teamRepoCache.set(key, { at: now, repos: discovered });
    }
  }
  return [...new Set([...discovered, ...ctx.teamRepos])];
}

/** Read one repo's knowledge.json at a ref into its items array (empty on
 *  absent/corrupt — a missing store is a normal empty answer). */
async function readItems(ctx: Ctx, repo: string, ref: string): Promise<KnowledgeItem[]> {
  const raw = await getContent(ctx, repo, ctx.knowledgePath, ref);
  if (!raw) return [];
  try {
    const doc = JSON.parse(raw) as { items?: unknown };
    return Array.isArray(doc.items) ? (doc.items as KnowledgeItem[]) : [];
  } catch {
    return [];
  }
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

interface Gathered {
  pool: Array<{ scope: string; item: KnowledgeItem }>;
  errors: Record<string, string>;
}

/** Gather (scope, item) pairs for the requested scopes, per-scope isolated: a
 *  scope (or a single team repo) that fails — e.g. the GH_PAT can't see a
 *  private repo — contributes nothing and is reported in `errors`, instead of
 *  throwing and losing the scopes that DID succeed. Team = each team repo's
 *  cambium branch; org = the org repo's default branch. */
async function gather(ctx: Ctx, wantTeam: boolean, wantOrg: boolean): Promise<Gathered> {
  const pool: Array<{ scope: string; item: KnowledgeItem }> = [];
  const errors: Record<string, string> = {};
  if (wantTeam) {
    let repos: string[] = [];
    try {
      repos = await resolveTeamRepos(ctx);
    } catch (e) {
      errors.team_discovery = errMsg(e);
    }
    for (const repo of repos) {
      try {
        for (const item of await readItems(ctx, repo, ctx.teamBranch)) {
          pool.push({ scope: "team", item });
        }
      } catch (e) {
        errors[`team:${repo}`] = errMsg(e);
      }
    }
  }
  if (wantOrg && ctx.orgRepo) {
    try {
      const branch = await getDefaultBranch(ctx, ctx.orgRepo);
      for (const item of await readItems(ctx, ctx.orgRepo, branch)) {
        pool.push({ scope: "org", item });
      }
    } catch (e) {
      errors.org = errMsg(e);
    }
  }
  return { pool, errors };
}

function endorsedNotes(item: KnowledgeItem): string[] {
  return (item.trust?.endorsements || [])
    .map((e) => (e.note || "").trim())
    .filter(Boolean);
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

export async function recall(ctx: Ctx, args: any): Promise<unknown> {
  const query = String(args?.query ?? "");
  const scope = String(args?.scope ?? "auto");
  if (!["auto", "team", "org"].includes(scope)) {
    return { error: "scope must be auto | team | org (local scope is desktop-only)" };
  }
  const limit = Math.max(1, Math.min(Number(args?.limit) || 5, 25));
  const q = tokens(query);
  const wantTeam = scope === "auto" || scope === "team";
  const wantOrg = scope === "auto" || scope === "org";

  const { pool, errors } = await gather(ctx, wantTeam, wantOrg);
  const scored = pool
    .filter((p) => (p.item.status || "active") === "active")
    .map((p) => ({ ...p, relevance: score(p.item, q) }))
    .filter((p) => p.relevance > 0)
    .sort((a, b) => b.relevance - a.relevance)
    .slice(0, limit);

  const results = scored.map((p) => {
    const notes = endorsedNotes(p.item);
    return {
      scope: p.scope,
      relevance: round3(p.relevance),
      id: p.item.id,
      kind: p.item.kind,
      content: p.item.content,
      why: p.item.why,
      ...(p.item.example ? { example: p.item.example } : {}),
      tags: p.item.tags,
      project: p.item.project,
      source: p.item.source,
      ...(notes.length ? { endorsed_as: notes } : {}),
    };
  });

  const top = scored.length ? scored[0].relevance : 0;
  const out: Record<string, unknown> = {
    query,
    results,
    top_relevance: round3(top),
    scopes_read: {
      team: wantTeam && (!!ctx.teamOwner || ctx.teamRepos.length > 0),
      org: wantOrg && !!ctx.orgRepo,
    },
    note: "read-only remote recall (team + org). local scope is desktop-only; this recall did not increment recall counts.",
  };
  if (Object.keys(errors).length) out.scope_errors = errors; // e.g. a private repo the GH_PAT can't see
  if (!scored.length || top < RELEVANCE_FLOOR) {
    out.no_confident_match = true;
    out.guidance =
      "No stored knowledge confidently matches this query. Do not present these results as established fact.";
  }
  return out;
}

export async function status(ctx: Ctx): Promise<unknown> {
  let teamRepos: string[] = [];
  try {
    teamRepos = await resolveTeamRepos(ctx);
  } catch {
    /* discovery error is surfaced by gather() below */
  }
  const teamG = teamRepos.length ? await gather(ctx, true, false) : { pool: [], errors: {} };
  const orgG = ctx.orgRepo ? await gather(ctx, false, true) : { pool: [], errors: {} };
  const activeOf = (arr: Array<{ item: KnowledgeItem }>) =>
    arr.filter((p) => (p.item.status || "active") === "active").length;
  const errors = { ...teamG.errors, ...orgG.errors };
  return {
    server: "cambium-remote",
    configured: {
      org_repo: ctx.orgRepo || null,
      team_owner: ctx.teamOwner || null, // team repos are auto-discovered under this owner
      team_repos_discovered: teamRepos, // grows automatically as repos are team-promoted
      team_branch: ctx.teamBranch,
      knowledge_path: ctx.knowledgePath,
    },
    counts: {
      team_repos: teamRepos.length,
      team_active: activeOf(teamG.pool),
      org_active: activeOf(orgG.pool),
    },
    ...(Object.keys(errors).length ? { errors } : {}),
    note: "Read-only recall Worker; team repos auto-discovered. Writes (endorse/promote/distill) are desktop-only.",
  };
}
