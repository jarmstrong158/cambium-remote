import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the GitHub layer so recall runs without network. Team repos read their
// TEAM_BRANCH; org reads its default branch.
vi.mock("../src/github.js", () => {
  const store: Record<string, string> = {
    // teamRepo@cambium
    "team/repo|cambium": JSON.stringify({
      items: [
        { id: "t1", status: "active", kind: "outcome", content: "deploy uses blue-green rollouts", tags: ["deploy"] },
        { id: "t2", status: "deprecated", content: "old deploy note", tags: ["deploy"] },
      ],
    }),
    // orgRepo@main
    "org/knowledge|main": JSON.stringify({
      items: [
        {
          id: "o1",
          status: "active",
          kind: "decision",
          content: "auth hashes passwords with argon2id",
          tags: ["auth"],
          trust: { endorsements: [{ by: "jonny", note: "org-wide auth rule" }] },
        },
      ],
    }),
  };
  return {
    GhPatMissingError: class extends Error {},
    getContent: async (_ctx: unknown, repo: string, _path: string, ref: string) =>
      store[`${repo}|${ref}`] ?? null,
    getDefaultBranch: async () => "main",
    // Team scope auto-discovers repos with a cambium branch; the mock returns
    // the one team repo in the store, as a real scan would.
    discoverTeamRepos: async () => ["team/repo"],
  };
});

import { buildCtx, recall, status } from "../src/tools.js";

describe("recall", () => {
  let ctx: ReturnType<typeof buildCtx>;
  beforeEach(() => {
    ctx = buildCtx({
      ORG_REPO: "org/knowledge",
      TEAM_OWNER: "team", // team repos are auto-discovered under this owner
      TEAM_BRANCH: "cambium",
      KNOWLEDGE_PATH: "knowledge.json",
    } as any);
  });

  it("recalls org knowledge and surfaces endorsed_as", async () => {
    const r: any = await recall(ctx, { query: "argon2id password hashing" });
    expect(r.results.length).toBeGreaterThan(0);
    expect(r.results[0].id).toBe("o1");
    expect(r.results[0].scope).toBe("org");
    expect(r.results[0].endorsed_as).toContain("org-wide auth rule");
    expect(r.no_confident_match).toBeUndefined();
  });

  it("skips deprecated items and reads team scope", async () => {
    const r: any = await recall(ctx, { query: "blue-green deploy rollout", scope: "team" });
    const ids = r.results.map((x: any) => x.id);
    expect(ids).toContain("t1");
    expect(ids).not.toContain("t2"); // deprecated
  });

  it("abstains honestly on a miss", async () => {
    const r: any = await recall(ctx, { query: "zzqx flurbo wumbo" });
    expect(r.results.length).toBe(0);
    expect(r.no_confident_match).toBe(true);
  });

  it("rejects a bad scope", async () => {
    const r: any = await recall(ctx, { query: "x", scope: "local" });
    expect(r.error).toMatch(/scope must be/);
  });

  it("auto-discovers team repos (not a static list)", async () => {
    const s: any = await status(ctx);
    expect(s.configured.team_owner).toBe("team");
    expect(s.configured.team_scope_mode).toBe("discover");
    expect(s.counts.team_repos).toBe(1);
    expect(s.counts.team_active).toBe(1); // t1 active; t2 deprecated is excluded
  });
});

// ---------------------------------------------------------------------------
// Scope is a read selector, not authorization. See src/types.ts TeamScopeMode.
// ---------------------------------------------------------------------------

describe("team scope trust model", () => {
  const base = {
    ORG_REPO: "org/knowledge",
    TEAM_OWNER: "team",
    TEAM_BRANCH: "cambium",
    KNOWLEDGE_PATH: "knowledge.json",
  };

  it("does not enumerate discovered repo names by default", async () => {
    // Discovered names include PRIVATE repositories, and status() is reachable
    // by anyone holding the path token -- who has no GitHub identity at all.
    const s: any = await status(buildCtx(base as any));
    expect(s.configured.team_repos).toMatch(/^hidden/);
    expect(JSON.stringify(s)).not.toContain("team/repo");
    // The count still answers the diagnostic question.
    expect(s.counts.team_repos).toBe(1);
  });

  it("discloses names only when explicitly opted in", async () => {
    const s: any = await status(buildCtx({ ...base, STATUS_DISCLOSE_REPOS: "true" } as any));
    expect(s.configured.team_repos).toContain("team/repo");
  });

  it("allowlist mode ignores TEAM_OWNER entirely and never scans", async () => {
    // Leaving TEAM_OWNER set in wrangler.toml must not silently re-widen scope.
    const ctx = buildCtx({ ...base, TEAM_SCOPE_MODE: "allowlist", TEAM_REPOS: "team/repo" } as any);
    expect(ctx.teamOwner).toBe("");
    const s: any = await status(ctx);
    expect(s.configured.team_scope_mode).toBe("allowlist");
    expect(s.configured.team_owner).toBeNull();
    // Named repos are the operator's own committed config, so they are shown.
    expect(s.configured.team_repos).toEqual(["team/repo"]);
    expect(s.counts.team_active).toBe(1);
  });

  it("allowlist mode with no TEAM_REPOS reads nothing from team scope", async () => {
    const ctx = buildCtx({ ...base, TEAM_SCOPE_MODE: "allowlist", TEAM_REPOS: "" } as any);
    const r: any = await recall(ctx, { query: "blue-green deploy rollout", scope: "team" });
    expect(r.results.length).toBe(0);
  });

  it("states the trust model in its own output rather than implying authorization", async () => {
    const discovered: any = await status(buildCtx(base as any));
    expect(discovered.trust_model).toMatch(/DISCOVERED, not authorized/);

    const strict: any = await status(
      buildCtx({ ...base, TEAM_SCOPE_MODE: "allowlist", TEAM_REPOS: "team/repo" } as any),
    );
    expect(strict.trust_model).toMatch(/strict allowlist/);
  });
});
