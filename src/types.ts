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
  TEAM_REPOS?: string; // OPTIONAL extra "owner/name" repos to include on top of
  //   discovery (e.g. repos under a different owner). Blank in the common case.
  TEAM_BRANCH?: string; // default "cambium"
  KNOWLEDGE_PATH?: string; // default "knowledge.json"
}

// Per-request execution context: resolved config plus an injectable clock so the
// core logic is deterministic under test.
export interface Ctx {
  env: Env;
  orgRepo: string; // "" if unconfigured
  teamOwner: string; // "" if team discovery is off
  teamRepos: string[]; // explicit extras, merged on top of discovery
  teamBranch: string;
  knowledgePath: string;
  now: () => string;
}
