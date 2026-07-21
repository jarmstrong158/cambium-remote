// cambium-remote tools: read-only recall over team + org knowledge, plus a
// status probe. No writes: recall does NOT increment recall counters (that would
// be a CAS write to the shared branch), which also means mobile recalls do not
// feed promotion — consistent with local cambium not tracking org-scope usage.

import { getContent, getDefaultBranch } from "./github.js";
import { RELEVANCE_FLOOR, score, tokens } from "./score.js";
import type { Ctx, Env, KnowledgeItem } from "./types.js";

export function buildCtx(env: Env): Ctx {
  return {
    env,
    orgRepo: (env.ORG_REPO || "").trim(),
    teamRepos: (env.TEAM_REPOS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    teamBranch: (env.TEAM_BRANCH || "cambium").trim(),
    knowledgePath: (env.KNOWLEDGE_PATH || "knowledge.json").trim(),
    now: () => new Date().toISOString(),
  };
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

/** Gather (scope, item) pairs for the requested scopes. Team = each team repo's
 *  cambium branch; org = the org repo's default branch. */
async function gather(
  ctx: Ctx,
  wantTeam: boolean,
  wantOrg: boolean,
): Promise<Array<{ scope: string; item: KnowledgeItem }>> {
  const pool: Array<{ scope: string; item: KnowledgeItem }> = [];
  if (wantTeam) {
    for (const repo of ctx.teamRepos) {
      for (const item of await readItems(ctx, repo, ctx.teamBranch)) {
        pool.push({ scope: "team", item });
      }
    }
  }
  if (wantOrg && ctx.orgRepo) {
    const branch = await getDefaultBranch(ctx, ctx.orgRepo);
    for (const item of await readItems(ctx, ctx.orgRepo, branch)) {
      pool.push({ scope: "org", item });
    }
  }
  return pool;
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

  const pool = await gather(ctx, wantTeam, wantOrg);
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
      team: wantTeam ? ctx.teamRepos.length : 0,
      org: wantOrg && !!ctx.orgRepo,
    },
    note: "read-only remote recall (team + org). local scope is desktop-only; this recall did not increment recall counts.",
  };
  if (!scored.length || top < RELEVANCE_FLOOR) {
    out.no_confident_match = true;
    out.guidance =
      "No stored knowledge confidently matches this query. Do not present these results as established fact.";
  }
  return out;
}

export async function status(ctx: Ctx): Promise<unknown> {
  const team = ctx.teamRepos.length ? await gather(ctx, true, false) : [];
  const org = ctx.orgRepo ? await gather(ctx, false, true) : [];
  const activeOf = (arr: Array<{ item: KnowledgeItem }>) =>
    arr.filter((p) => (p.item.status || "active") === "active").length;
  return {
    server: "cambium-remote",
    configured: {
      org_repo: ctx.orgRepo || null,
      team_repos: ctx.teamRepos,
      team_branch: ctx.teamBranch,
      knowledge_path: ctx.knowledgePath,
    },
    counts: {
      team_active: activeOf(team),
      org_active: activeOf(org),
    },
    note: "Read-only recall Worker. Writes (endorse/promote/distill) are desktop-only.",
  };
}
