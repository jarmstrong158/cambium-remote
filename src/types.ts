// Shared types for cambium-remote.
//
// The read shape here is the compatibility contract with local cambium
// (github.com/jarmstrong158/cambium): a knowledge.json is `{ "items": [...] }`,
// and each item carries the fields cambium's recall() reads. This Worker only
// READS those files (team scope = a project's `cambium` branch; org scope = the
// dedicated org knowledge repo's default branch), so it never has to reproduce
// cambium's write path (CAS, the generalization gate, promotion).

export interface KnowledgeItem {
  id: string;
  type?: string;
  kind?: string;
  content?: string;
  why?: string;
  example?: string;
  tags?: string[];
  scope?: string;
  project?: string;
  status?: string;
  valid_while?: string;
  last_verified?: string;
  trust?: {
    recalls?: number;
    endorsements?: Array<{ by?: string; at?: string; note?: string }>;
    projects?: string[];
  };
  source?: { system?: string; ref?: string; imported?: boolean };
}

export interface KnowledgeDoc {
  items: KnowledgeItem[];
}

/**
 * How the team-scope repo set is determined.
 *
 * "discover" (default, and the historical behaviour) is a TOPOLOGICAL READ
 * SELECTOR, not an authorization control. It reads every repo under TEAM_OWNER
 * that has a TEAM_BRANCH. There is no allowlist and no denylist, so ANYONE who
 * can push a `cambium` branch to ANY repo under that owner -- an outside
 * contributor with write access to one small repo, a compromised CI token, a
 * stale collaborator -- gets their knowledge.json injected into org-wide recall
 * within the discovery cache TTL. "Scope" here answers "where do we look", not
 * "who is allowed to tell us things".
 *
 * "allowlist" is the opt-in strict mode: team scope is EXACTLY the repos named
 * in TEAM_REPOS, discovery is not performed at all, and adding a repo is a
 * deliberate config change. Choose this if anyone other than you can push to a
 * repo under TEAM_OWNER.
 */
export type TeamScopeMode = "discover" | "allowlist";

// Worker configuration + secrets binding.
export interface Env {
  // Secrets (set in the Cloudflare dashboard, never in code/repo).
  AUTH_TOKEN?: string;
  GH_PAT?: string;
  // Vars (wrangler.toml).
  ORG_REPO?: string; // "owner/name" of the dedicated org knowledge repo
  TEAM_OWNER?: string; // owner (user/org) to AUTO-DISCOVER team repos under:
  //   every repo of this owner that has a TEAM_BRANCH is read for team knowledge,
  //   so newly-promoted repos are picked up with no config change.
  //   IGNORED when TEAM_SCOPE_MODE = "allowlist".
  TEAM_REPOS?: string; // In "discover" mode: OPTIONAL extra "owner/name" repos
  //   to include on top of discovery. In "allowlist" mode: the COMPLETE set.
  TEAM_SCOPE_MODE?: string; // "discover" (default) | "allowlist". See TeamScopeMode.
  TEAM_BRANCH?: string; // default "cambium"
  KNOWLEDGE_PATH?: string; // default "knowledge.json"
  STATUS_DISCLOSE_REPOS?: string; // "true" to let status() list repo NAMES.
  //   Default false: in discover mode those names include PRIVATE repos, and
  //   status() is reachable by anyone holding the path token.
}

// Per-request execution context: resolved config plus an injectable clock so the
// core logic is deterministic under test.
export interface Ctx {
  env: Env;
  orgRepo: string; // "" if unconfigured
  teamOwner: string; // "" if team discovery is off
  teamRepos: string[]; // discover mode: explicit extras. allowlist mode: the whole set.
  teamScopeMode: TeamScopeMode;
  teamBranch: string;
  knowledgePath: string;
  discloseRepos: boolean; // may status() return repo NAMES rather than a count?
  now: () => string;
}
