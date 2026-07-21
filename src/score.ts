// Lexical recall scoring — a faithful port of local cambium's _tokens/_score
// (cambium_server.py), so a mobile recall ranks the same way a desktop recall
// does. Deterministic, dependency-free. Includes the prefix-substring precision
// fix (a >=3-char token matches a stored word only on a shared PREFIX, so "art"
// does not spuriously match "start" while "hash"~"hashing" still does).

import type { KnowledgeItem } from "./types.js";

// Below this relevance the top match is not confident (cambium's RELEVANCE_FLOOR).
export const RELEVANCE_FLOOR = 0.2;

/** Lowercase alphanumeric tokens of length > 1. */
export function tokens(text: string): Set<string> {
  const cleaned = (text || "").toLowerCase().replace(/[^a-z0-9]+/g, " ");
  const out = new Set<string>();
  for (const w of cleaned.split(/\s+/)) if (w.length > 1) out.add(w);
  return out;
}

/** Fraction of query tokens the item matches; tags and kind count double, and
 *  >=3-char tokens match a stored word on a shared prefix. Mirrors _score. */
export function score(item: KnowledgeItem, q: Set<string>): number {
  if (q.size === 0) return 0;
  const body = new Set<string>([
    ...tokens(item.content || ""),
    ...tokens(item.why || ""),
  ]);
  const tagset = new Set<string>([
    ...(item.tags || []).map((t) => t.toLowerCase()),
    (item.kind || "").toLowerCase(),
  ]);
  let hits = 0;
  for (const tok of q) {
    if (tagset.has(tok)) {
      hits += 2;
    } else if (body.has(tok) || [...tagset].some((t) => t.includes(tok))) {
      hits += 1;
    } else if (
      tok.length >= 3 &&
      [...body].some(
        (w) => w.length >= 3 && (w.startsWith(tok) || tok.startsWith(w)),
      )
    ) {
      hits += 1;
    }
  }
  return Math.min(1, hits / q.size);
}
