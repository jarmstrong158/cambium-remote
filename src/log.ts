// One-line structured logging to the Worker console (Cloudflare tail /
// observability). Best-effort: a logging failure must never break a request.
export function log(event: string, data: Record<string, unknown> = {}): void {
  try {
    console.log(JSON.stringify({ event, ...data }));
  } catch {
    /* never throw from a log call */
  }
}
