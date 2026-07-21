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
  };
});

import { buildCtx, recall } from "../src/tools.js";

describe("recall", () => {
  let ctx: ReturnType<typeof buildCtx>;
  beforeEach(() => {
    ctx = buildCtx({
      ORG_REPO: "org/knowledge",
      TEAM_REPOS: "team/repo",
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
});
