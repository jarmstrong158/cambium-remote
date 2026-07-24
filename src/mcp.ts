// A small, self-contained stateless Streamable HTTP MCP handler. Modeled on the
// sibling agentsync-remote Worker: the JSON-RPC plumbing is identical; only the
// TOOLS array differs. This Worker holds no state (its only state lives in
// GitHub), so a stateless request/response JSON-RPC handler is the exact fit.

import { GhPatMissingError } from "./github.js";
import { log } from "./log.js";
import {
  type JsonRpcMessage,
  type JsonSchemaLike,
  RPC_INVALID_PARAMS,
  RPC_METHOD_NOT_FOUND,
  handleJsonRpcHttp,
  isNotification,
  negotiateProtocol,
  rpcError,
  rpcResult,
  validateArguments,
} from "./shared/mcp-core.js";
import { recall, status } from "./tools.js";
import type { Ctx } from "./types.js";

const SERVER_INFO = { name: "cambium-remote", version: "0.1.0" };

interface ToolDef {
  name: string;
  description: string;
  inputSchema: JsonSchemaLike;
  handler: (ctx: Ctx, args: any) => Promise<unknown>;
}

/** Longest query we will accept. A recall query is scored against every item in
 *  every in-scope repo, so its length is a per-item cost multiplier. */
const MAX_QUERY_LENGTH = 2000;

export const TOOLS: ToolDef[] = [
  {
    name: "recall",
    description:
      "Search the team and org knowledge cambium has distilled and promoted, " +
      "and return the best matches. This is the mobile/remote read endpoint for " +
      "compound knowledge — past outcomes, gotchas, and decisions. It is " +
      "read-only: local (personal, unpromoted) scope is desktop-only and not " +
      "reachable here, and a recall here does not count toward promotion. If " +
      "nothing clears the relevance floor the response says no_confident_match; " +
      "do not present weak matches as established fact.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          minLength: 1,
          maxLength: MAX_QUERY_LENGTH,
          description: "What you want to recall.",
        },
        scope: {
          type: "string",
          enum: ["auto", "team", "org"],
          description: "auto (team+org, default) | team | org.",
        },
        limit: {
          type: "number",
          minimum: 1,
          maximum: 25,
          description: "Max results (default 5, max 25).",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    handler: (ctx, a) => recall(ctx, a),
  },
  {
    name: "status",
    description:
      "Report what this Worker is configured to read (org repo, team repos, " +
      "branch) and how many active items each scope currently holds. Call it " +
      "first if recall looks empty.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: (ctx) => status(ctx),
  },
];

// --------------------------------------------------------------------------
// JSON-RPC plumbing
//
// The envelope, protocol negotiation and argument validation live in
// src/shared/mcp-core.ts, shared byte-identically with context-keeper-remote
// and agentsync-remote. This file used to say the plumbing was "identical to
// agentsync-remote's proven handler"; it was a copy, and copies drift. Now it
// is genuinely the same code.
// --------------------------------------------------------------------------

async function handleMessage(msg: JsonRpcMessage, ctx: Ctx): Promise<object | null> {
  const method = msg.method;

  switch (method) {
    case "initialize": {
      // Previously echoed whatever the client sent, so asking for "banana"
      // returned `protocolVersion: "banana"`. An unrecognized request now
      // negotiates DOWN to our pinned revision.
      const { version, requested, downgraded } = negotiateProtocol(msg.params?.protocolVersion);
      log("handshake", { phase: "start", protocol_version: version, requested, downgraded });
      return rpcResult(msg.id, {
        protocolVersion: version,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    }

    case "ping":
      return rpcResult(msg.id, {});

    case "tools/list":
      return rpcResult(msg.id, {
        tools: TOOLS.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      });

    case "tools/call": {
      const name = msg.params?.name;
      const started = Date.now();
      const tool = TOOLS.find((t) => t.name === name);
      if (!tool) {
        log("error", { message: `Unknown tool: ${name}` });
        return rpcError(msg.id, RPC_INVALID_PARAMS, `Unknown tool: ${name}`);
      }

      // ENFORCE the schema we advertise. Handlers previously took
      // `msg.params?.arguments ?? {}` raw, so a non-string `query` reached the
      // scorer and a non-numeric `limit` reached Array.slice.
      const args = msg.params?.arguments ?? {};
      const problems = validateArguments(tool.inputSchema, args);
      if (problems.length > 0) {
        log("error", { message: `Invalid arguments for ${name}: ${problems.join("; ")}` });
        return rpcError(
          msg.id,
          RPC_INVALID_PARAMS,
          `Invalid arguments for ${name}: ${problems.join("; ")}`,
        );
      }

      try {
        const out = await tool.handler(ctx, args);
        log("tool_call", { tool: name, duration_ms: Date.now() - started, ok: true });
        return rpcResult(msg.id, {
          content: [{ type: "text", text: JSON.stringify(out, null, 2) }],
          isError: false,
        });
      } catch (e) {
        const message =
          e instanceof GhPatMissingError
            ? `Configuration error: ${e.message}`
            : `Error: ${e instanceof Error ? e.message : String(e)}`;
        log("tool_call", { tool: name, duration_ms: Date.now() - started, ok: false });
        log("error", { message: e instanceof Error ? e.message : String(e) });
        return rpcResult(msg.id, { content: [{ type: "text", text: message }], isError: true });
      }
    }

    default:
      if (isNotification(msg)) return null;
      return rpcError(msg.id, RPC_METHOD_NOT_FOUND, `Method not found: ${method}`);
  }
}

export function createMcpHandler(): (request: Request, ctx: Ctx) => Promise<Response> {
  return async (request: Request, ctx: Ctx): Promise<Response> => {
    return handleJsonRpcHttp(request, (msg) => handleMessage(msg, ctx), {
      // No server-initiated SSE stream and no session to tear down.
      allow: "POST, DELETE",
      handleDelete: true,
      onError: (e) => log("error", { message: e instanceof Error ? e.message : String(e) }),
    });
  };
}
