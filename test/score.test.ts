import { describe, expect, it } from "vitest";
import { RELEVANCE_FLOOR, score, tokens } from "../src/score.js";

describe("tokens", () => {
  it("lowercases and drops length<=1 tokens", () => {
    expect([...tokens("A JWT rule x")].sort()).toEqual(["jwt", "rule"]);
  });
});

describe("score", () => {
  const item = (content: string, tags: string[] = [], kind = "note") => ({
    id: "k1",
    content,
    tags,
    kind,
  });

  it("tags/kind count double", () => {
    // one query token, present as a tag -> hits 2, capped at 1.0
    expect(score(item("body", ["deploy"]), tokens("deploy"))).toBe(1);
  });

  it("matches a shared prefix (hash~hashing) but not a bare infix (art~start)", () => {
    expect(score(item("argon2 password hashing"), tokens("hash"))).toBe(1);
    expect(score(item("the program will start soon"), tokens("art"))).toBe(0);
  });

  it("exact body token matches", () => {
    expect(score(item("the deploy pipeline"), tokens("pipeline"))).toBe(1);
  });

  it("nonsense abstains below the floor", () => {
    const s = score(item("grafana latency dashboard"), tokens("zzqx flurbo wumbo"));
    expect(s).toBeLessThan(RELEVANCE_FLOOR);
  });
});
