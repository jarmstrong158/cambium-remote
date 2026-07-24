// cambium-remote tools: read-only recall over team + org knowledge, plus a
// status probe. No writes: recall does NOT increment recall counters (that would
// be a CAS write to the shared branch), which also means mobile recalls do not
// feed promotion — consistent with local cambium not tracking org-scope usage.

import { GhPatMissingError, discoverTeamRepos, getContent, getDefaultBranch } from "./github.js";
import { RELEVANCE_FLOOR, score, tokens } from "./score.js";
import type { Ctx, Env, KnowledgeItem, TeamScopeMode } from "./types.js";

export function buildCtx(env: Env): Ctx {
  const mode: TeamScopeMode =
    (env.TEAM_SCOPE_MODE || "").trim().toLowerCase() === "allowlist" ? "allowlist" : "discover";
  return {
    env,
    orgRepo: (env.ORG_REPO || "").trim(),
    // In allowlist mode TEAM_OWNER is ignored entirely: no discovery is
    // performed, so leaving it set in wrangler.toml cannot silently re-widen
    // the scope.
    teamOwner: mode === "allowlist" ? "" : (env.TEAM_OWNER || "").trim(),
    teamRepos: (env.TEAM_REPOS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    teamScopeMode: mode,
    teamBranch: (env.TEAM_BRANCH || "cambium").trim(),
    knowledgePath: (env.KNOWLEDGE_PATH || "knowledge.json").trim(),
    discloseRepos: (env.STATUS_DISCLOSE_REPOS || "").trim().toLowerCase() === "true",
    now: () => new Date().toISOString(),
  };
}

// In "discover" mode team scope is a GROWING set, so we discover it (see
// github.discoverTeamRepos) rather than read a static list. Discovery is cached
// per (owner, branch) in the isolate for a few minutes so a burst of recalls
// costs one scan, and a newly team-promoted repo shows up within the TTL — no
// redeploy, no config edit.
//
// Be clear-eyed about what that is: discovery is a TOPOLOGICAL READ SELECTOR,
// not an authorization decision. "Has a cambium branch under TEAM_OWNER" is the
// entire membership test — no allowlist, no denylist, no signature, no
// provenance check on the items themselves. Anyone who can push a `cambium`
// branch to ANY repo under that owner has their knowledge.json folded into
// org-wide recall within TEAM_CACHE_TTL_MS, and recall output is exactly the
// kind of thing an agent treats as established fact. Set
// TEAM_SCOPE_MODE="allowlist" if anyone but you can push under TEAM_OWNER.
const TEAM_CACHE_TTL_MS = 5 * 60 * 1000;
const teamRepoCache = new Map<string, { at: number; repos: string[] }>();

/** The team-repo set for this ctx.
 *
 *  allowlist mode: EXACTLY ctx.teamRepos. No discovery call is made at all.
 *  discover mode:  auto-discovered under TEAM_OWNER, plus any explicit
 *                  TEAM_REPOS extras, deduped. */
async function resolveTeamRepos(ctx: Ctx): Promise<string[]> {
  if (ctx.teamScopeMode === "allowlist") return [...new Set(ctx.teamRepos)];

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

/**
 * Per-scope isolation is for PARTIAL failures -- one unreadable repo, a
 * transient 5xx. A missing GH_PAT is not that: it fails every scope
 * identically, and burying it in `scope_errors` turns "this Worker is not
 * configured" into "no knowledge matched your query", which is exactly the
 * confident-sounding empty answer recall is supposed to never give. It stays
 * fatal so mcp.ts reports it as a named isError with setup instructions.
 */
function rethrowIfFatal(e: unknown): void {
  if (e instanceof GhPatMissingError) throw e;
}

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
      rethrowIfFatal(e);
      errors.team_discovery = errMsg(e);
    }
    for (const repo of repos) {
      try {
        for (const item of await readItems(ctx, repo, ctx.teamBranch)) {
          pool.push({ scope: "team", item });
        }
      } catch (e) {
        rethrowIfFatal(e);
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
      rethrowIfFatal(e);
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
  } catch (e) {
    // A missing GH_PAT is fatal and must reach the caller as a configuration
    // error; anything else is surfaced per-scope by gather() below.
    rethrowIfFatal(e);
  }
  const teamG = teamRepos.length ? await gather(ctx, true, false) : { pool: [], errors: {} };
  const orgG = ctx.orgRepo ? await gather(ctx, false, true) : { pool: [], errors: {} };
  const activeOf = (arr: Array<{ item: KnowledgeItem }>) =>
    arr.filter((p) => (p.item.status || "active") === "active").length;
  const errors = { ...teamG.errors, ...orgG.errors };

  // Repo NAMES are gated. In discover mode this list is the output of a scan
  // over everything TEAM_OWNER owns, so it enumerates PRIVATE repositories --
  // their existence and their names -- to anyone holding the path token, who
  // has no GitHub identity and no repo permissions of their own. That is a
  // disclosure the tool was never supposed to make, and a count answers the
  // actual diagnostic question ("is team scope finding anything?") just as
  // well. Set STATUS_DISCLOSE_REPOS="true" to opt back in.
  //
  // In allowlist mode the names are the operator's own committed config rather
  // than a discovery result, so they are shown -- there is nothing to leak that
  // wrangler.toml does not already state.
  const disclose = ctx.discloseRepos || ctx.teamScopeMode === "allowlist";

  return {
    server: "cambium-remote",
    configured: {
      org_repo: ctx.orgRepo || null,
      team_scope_mode: ctx.teamScopeMode,
      team_owner: ctx.teamOwner || null,
      team_branch: ctx.teamBranch,
      knowledge_path: ctx.knowledgePath,
      ...(disclose
        ? { team_repos: teamRepos }
        : {
            team_repos:
              "hidden (discovered names can include private repositories; " +
              'set STATUS_DISCLOSE_REPOS="true" to show them)',
          }),
    },
    counts: {
      team_repos: teamRepos.length,
      team_active: activeOf(teamG.pool),
      org_active: activeOf(orgG.pool),
    },
    ...(Object.keys(errors).length ? { errors } : {}),
    trust_model:
      ctx.teamScopeMode === "allowlist"
        ? "Team scope is a strict allowlist (TEAM_REPOS). Adding a repo requires a config change."
        : "Team scope is DISCOVERED, not authorized: any repo under TEAM_OWNER with a " +
          `'${ctx.teamBranch}' branch is read. Anyone able to push that branch can inject into ` +
          'recall. Set TEAM_SCOPE_MODE="allowlist" to require explicit opt-in per repo.',
    note: "Read-only recall Worker. Writes (endorse/promote/distill) are desktop-only.",
  };
}
