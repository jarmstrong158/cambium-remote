// A small, self-contained stateless Streamable HTTP MCP handler. Modeled on the
// sibling agentsync-remote Worker: the JSON-RPC plumbing is identical; only the
// TOOLS array differs. This Worker holds no state (its only state lives in
// GitHub), so a stateless request/response JSON-RPC handler is the exact fit.

import { GhPatMissingError } from "./github.js";
import { log } from "./log.js";
import { recall, status } from "./tools.js";
import type { Ctx } from "./types.js";

const PROTOCOL_VERSION = "2025-06-18";
const SERVER_INFO = { name: "cambium-remote", version: "0.1.0" };

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (ctx: Ctx, args: any) => Promise<unknown>;
}

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
        query: { type: "string", description: "What you want to recall." },
        scope: {
          type: "string",
          enum: ["auto", "team", "org"],
          description: "auto (team+org, default) | team | org.",
        },
        limit: { type: "number", description: "Max results (default 5, max 25)." },
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
// JSON-RPC plumbing (identical to agentsync-remote's proven handler)
// --------------------------------------------------------------------------

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: any;
}

function result(id: string | number | null | undefined, res: unknown) {
  return { jsonrpc: "2.0", id: id ?? null, result: res };
}

function error(id: string | number | null | undefined, code: number, message: string) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

async function handleMessage(msg: JsonRpcMessage, ctx: Ctx): Promise<object | null> {
  const method = msg.method;
  const isNotification = msg.id === undefined || method?.startsWith("notifications/");

  switch (method) {
    case "initialize": {
      const requested =
        typeof msg.params?.protocolVersion === "string" ? msg.params.protocolVersion : undefined;
      const negotiated = requested ?? PROTOCOL_VERSION;
      return result(msg.id, {
        protocolVersion: negotiated,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    }

    case "ping":
      return result(msg.id, {});

    case "tools/list":
      return result(msg.id, {
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
        return error(msg.id, -32602, `Unknown tool: ${name}`);
      }
      try {
        const out = await tool.handler(ctx, msg.params?.arguments ?? {});
        log("tool_call", { tool: name, duration_ms: Date.now() - started, ok: true });
        return result(msg.id, {
          content: [{ type: "text", text: JSON.stringify(out, null, 2) }],
        });
      } catch (e) {
        const message =
          e instanceof GhPatMissingError
            ? `Configuration error: ${e.message}`
            : `Error: ${e instanceof Error ? e.message : String(e)}`;
        log("tool_call", { tool: name, duration_ms: Date.now() - started, ok: false });
        log("error", { message: e instanceof Error ? e.message : String(e) });
        return result(msg.id, { content: [{ type: "text", text: message }], isError: true });
      }
    }

    default:
      if (isNotification) return null;
      return error(msg.id, -32601, `Method not found: ${method}`);
  }
}

export function createMcpHandler(): (request: Request, ctx: Ctx) => Promise<Response> {
  return async (request: Request, ctx: Ctx): Promise<Response> => {
    if (request.method === "GET") {
      return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST, DELETE" } });
    }
    if (request.method === "DELETE") {
      return new Response(null, { status: 204 });
    }
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST, DELETE" } });
    }

    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      return json(error(null, -32700, "Parse error"), 200);
    }

    const isBatch = Array.isArray(payload);
    const messages = (isBatch ? payload : [payload]) as JsonRpcMessage[];

    const responses: object[] = [];
    for (const message of messages) {
      let res: object | null;
      try {
        res = await handleMessage(message, ctx);
      } catch (e) {
        log("error", { message: e instanceof Error ? e.message : String(e) });
        res = error(message?.id ?? null, -32603, "Internal error");
      }
      if (res !== null) responses.push(res);
    }

    if (responses.length === 0) return new Response(null, { status: 202 });
    return json(isBatch ? responses : responses[0], 200);
  };
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
