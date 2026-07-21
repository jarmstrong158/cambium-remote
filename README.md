# cambium-remote

_Part of the [xylem](https://github.com/jarmstrong158/xylem) stack._

A Cloudflare Worker MCP server that makes **cambium's promoted knowledge**
recallable from **claude.ai (including mobile)** — read-only.

Local cambium is a desktop stdio server; its **team** knowledge lives on a
`cambium` branch of each project repo and its **org** knowledge lives in a
dedicated knowledge repo — both plain `knowledge.json` files in git. This Worker
reads those files through the GitHub Contents API and serves `recall()` over
them, the same pattern [`agentsync-remote`](https://github.com/jarmstrong158/agentsync-remote)
uses for the coordination board.

**Read-only by design.** It exposes `recall` and `status`. It does **not**
`distill`, `endorse`, or `promote` (those are CAS writes / the generalization
gate — desktop-only), and recall here does **not** increment recall counts (so
it never feeds promotion). Local (personal, unpromoted) scope is desktop-only
and not reachable remotely — only the promoted **team** and **org** tiers are.

## Tools

- **`recall(query, scope?, limit?)`** — search team + org knowledge. `scope`:
  `auto` (default, team+org) | `team` | `org`. Abstains with
  `no_confident_match` below the relevance floor, exactly like local cambium.
- **`status()`** — what the Worker is configured to read and how many active
  items each scope holds. Call it first if recall looks empty.

## Configure (`wrangler.toml` vars)

| var | meaning |
|---|---|
| `ORG_REPO` | `owner/name` of the dedicated org knowledge repo (its default branch's `knowledge.json`). Blank = no org recall. |
| `TEAM_REPOS` | comma-separated `owner/name` repos whose `TEAM_BRANCH` holds team knowledge. Blank = no team recall. |
| `TEAM_BRANCH` | team-scope branch (default `cambium`). |
| `KNOWLEDGE_PATH` | file name (default `knowledge.json`). |

## Deploy

```bash
npm install
npm run typecheck && npm test
npx wrangler deploy
# then set the two secrets in the Cloudflare dashboard (never in the repo):
npx wrangler secret put AUTH_TOKEN   # the path-token credential; URL is /mcp/<AUTH_TOKEN>
npx wrangler secret put GH_PAT       # fine-grained GitHub token, Contents: Read, scoped to ORG_REPO + TEAM_REPOS
```

Then add `https://cambium-remote.<subdomain>.workers.dev/mcp/<AUTH_TOKEN>` as a
custom connector in **claude.ai → Settings → Connectors**. The whole URL is the
credential — treat it like a password.

## Auth

Path-token: `POST /mcp/<token>`, constant-time compared to the `AUTH_TOKEN`
secret; anything else returns a bare `404`. Same scheme as the sibling Workers.

## License

[PolyForm Noncommercial License 1.0.0](https://github.com/jarmstrong158/xylem) —
free for any noncommercial use.
