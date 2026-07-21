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
  TEAM_REPOS?: string; // comma-separated "owner/name" list; team knowledge is on each's TEAM_BRANCH
  TEAM_BRANCH?: string; // default "cambium"
  KNOWLEDGE_PATH?: string; // default "knowledge.json"
}

// Per-request execution context: resolved config plus an injectable clock so the
// core logic is deterministic under test.
export interface Ctx {
  env: Env;
  orgRepo: string; // "" if unconfigured
  teamRepos: string[];
  teamBranch: string;
  knowledgePath: string;
  now: () => string;
}
