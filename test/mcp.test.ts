// Tests for src/index.ts -- the AUTH BOUNDARY -- and the MCP protocol surface.
//
// This file did not exist. cambium-remote shipped with no test of index.ts at
// all, in the one Worker of the three that holds the broadest GH_PAT: its team
// scope needs Metadata:Read + Contents:Read across EVERY repo under TEAM_OWNER,
// including private ones. A regression in the path-token check here does not
// leak one project's coordination file, it hands over read access to an entire
// account's repositories. That warrants more coverage than the siblings, not
// less.

import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index.js";
import { createMcpHandler } from "../src/mcp.js";
import { buildCtx } from "../src/tools.js";
import type { Env } from "../src/types.js";
import { ENV, fakeGitHub, post } from "./helpers.js";

afterEach(() => vi.unstubAllGlobals());

const PING = { jsonrpc: "2.0", id: 1, method: "ping" };

// ---------------------------------------------------------------------------
// The auth boundary.
// ---------------------------------------------------------------------------

describe("auth (fail closed)", () => {
  it("wrong token -> bare 404 with no detail", async () => {
    const res = await worker.fetch(post("wrong", PING), ENV);
    expect(res.status).toBe(404);
    // Must not confirm that the path shape was right, or that a token exists.
    expect(await res.text()).toBe("Not Found");
  });

  it("unset AUTH_TOKEN -> 404 even with a token in the path", async () => {
    // An unconfigured Worker must authenticate NOBODY, not everybody.
    const res = await worker.fetch(post("anything", PING), { ...ENV, AUTH_TOKEN: undefined });
    expect(res.status).toBe(404);
  });

  it("empty AUTH_TOKEN -> 404, including for an empty path token", async () => {
    expect((await worker.fetch(post("x", PING), { ...ENV, AUTH_TOKEN: "" })).status).toBe(404);
    expect((await worker.fetch(post("", PING), { ...ENV, AUTH_TOKEN: "" })).status).toBe(404);
  });

  it("non-/mcp path -> 404", async () => {
    const res = await worker.fetch(
      new Request("https://w.example/", { method: "POST", body: "{}" }),
      ENV,
    );
    expect(res.status).toBe(404);
  });

  it("extra path segments after the token -> 404", async () => {
    const res = await worker.fetch(
      new Request("https://w.example/mcp/secret/extra", { method: "POST", body: "{}" }),
      ENV,
    );
    expect(res.status).toBe(404);
  });

  it("a token that merely PREFIXES the secret -> 404", async () => {
    expect((await worker.fetch(post("secre", PING), ENV)).status).toBe(404);
    expect((await worker.fetch(post("secretx", PING), ENV)).status).toBe(404);
  });

  it("percent-decodes the token, matching the sibling Workers", async () => {
    // This Worker did not decode before the shared core landed, so a token with
    // an escaped character authenticated against context-keeper-remote and
    // 404'd here.
    const env = { ...ENV, AUTH_TOKEN: "a b+c" };
    expect((await worker.fetch(post("a%20b%2Bc", PING), env)).status).toBe(200);
    expect((await worker.fetch(post("a+b+c", PING), env)).status).toBe(404);
  });

  it("a malformed percent-escape is a 404, not a 500", async () => {
    // decodeURIComponent("%zz") throws URIError; an uncaught throw here would
    // itself be an oracle (500 = "path matched, token didn't decode").
    const res = await worker.fetch(post("%zz", PING), ENV);
    expect(res.status).toBe(404);
  });

  it("an absurdly long token is rejected", async () => {
    expect((await worker.fetch(post("x".repeat(5000), PING), ENV)).status).toBe(404);
  });

  it("correct token -> ping succeeds", async () => {
    const res = await worker.fetch(post("secret", PING), ENV);
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).result).toEqual({});
  });

  it("never touches GitHub before the token is accepted", async () => {
    // A rejected request must not spend the GH_PAT, or a 404 becomes a way to
    // make the Worker act as a credentialed proxy.
    const fake = fakeGitHub();
    vi.stubGlobal("fetch", fake.fetch);
    await worker.fetch(
      post("wrong", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "status" } }),
      ENV,
    );
    expect(fake.state.authHeaders).toEqual([]);
  });

  it("rejects non-POST verbs on a VALID token without doing work", async () => {
    const res = await worker.fetch(
      new Request("https://w.example/mcp/secret", { method: "GET" }),
      ENV,
    );
    expect(res.status).toBe(405);
  });
});

// ---------------------------------------------------------------------------
// Protocol surface.
// ---------------------------------------------------------------------------

describe("protocol", () => {
  const handler = createMcpHandler();
  const ctx = () => buildCtx(ENV as Env);
  const req = (body: unknown) =>
    new Request("https://w.example/mcp/secret", { method: "POST", body: JSON.stringify(body) });

  it("initialize returns capabilities and serverInfo", async () => {
    const res = await handler(req({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }), ctx());
    const json = (await res.json()) as any;
    expect(json.result.serverInfo.name).toBe("cambium-remote");
    expect(json.result.capabilities.tools).toBeDefined();
  });

  it("validates protocolVersion instead of echoing it", async () => {
    const ask = async (protocolVersion: unknown) => {
      const res = await handler(
        req({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion } }),
        ctx(),
      );
      return ((await res.json()) as any).result.protocolVersion;
    };
    expect(await ask("banana")).toBe("2025-06-18");
    expect(await ask(42)).toBe("2025-06-18");
    expect(await ask(undefined)).toBe("2025-06-18");
    expect(await ask("2024-11-05")).toBe("2024-11-05");
  });

  it("tools/list exposes recall and status", async () => {
    const res = await handler(req({ jsonrpc: "2.0", id: 2, method: "tools/list" }), ctx());
    const names = ((await res.json()) as any).result.tools.map((t: any) => t.name).sort();
    expect(names).toEqual(["recall", "status"]);
  });

  it("notifications/initialized yields 202 with no body", async () => {
    const res = await handler(req({ jsonrpc: "2.0", method: "notifications/initialized" }), ctx());
    expect(res.status).toBe(202);
  });

  it("GET is 405 (no server-initiated stream)", async () => {
    const res = await handler(new Request("https://w.example/mcp/secret", { method: "GET" }), ctx());
    expect(res.status).toBe(405);
  });

  it("unknown tool -> JSON-RPC error", async () => {
    const res = await handler(
      req({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "nope" } }),
      ctx(),
    );
    expect(((await res.json()) as any).error.code).toBe(-32602);
  });

  it("surfaces a missing GH_PAT as a named isError message", async () => {
    const res = await handler(
      req({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "status" } }),
      buildCtx({ ...ENV, GH_PAT: undefined } as Env),
    );
    const json = (await res.json()) as any;
    expect(json.result.isError).toBe(true);
    expect(json.result.content[0].text).toMatch(/GH_PAT/);
  });

  it("enforces the advertised recall schema", async () => {
    const call = async (args: unknown) => {
      const res = await handler(
        req({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "recall", arguments: args } }),
        ctx(),
      );
      return (await res.json()) as any;
    };
    expect((await call({})).error.message).toMatch(/query: required/);
    expect((await call({ query: 42 })).error.message).toMatch(/expected string, got integer/);
    expect((await call({ query: "x", limit: 999 })).error.message).toMatch(/<= 25/);
    expect((await call({ query: "x", scope: "local" })).error.message).toMatch(/must be one of/);
    expect((await call({ query: "x", nope: true })).error.message).toMatch(/unexpected property/);
    expect((await call({ query: "x".repeat(2001) })).error.message).toMatch(/at most 2000/);
  });
});
