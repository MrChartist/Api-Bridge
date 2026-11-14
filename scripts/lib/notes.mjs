/** Plain-words access notes for an operation, derived from its x- flags and security block (shared by all generators). */

/** One short line: who may call it. */
export function accessLine(op) {
  if (op.bodyKey) return "Send your Bridge API key as `apikey` in the JSON body (no Authorization header).";
  if (op.path.startsWith("/hooks/")) return "No Bridge key. The hook token in the URL is the credential (generic hooks also need a signature).";
  if (op.noAuth) return "No API key needed.";
  const scope = op.scope ?? "read";
  const base = {
    read: "An API key with the `read` scope (any key).",
    paper: "An API key with the `paper` scope (or `live`).",
    live: "An API key with the `live` scope.",
    admin: "An API key with the `admin` scope.",
  }[scope] ?? `An API key with the \`${scope}\` scope.`;
  return op.queryKey ? `${base} A read-only key made with --allow-query may also pass \`?key=\`.` : base;
}

/** Extra sentences: this-computer-only, demo-only, paper default. */
export function cautionLines(op) {
  const lines = [];
  if (op.loopbackOnly) lines.push("This computer only: the Bridge refuses this call from any other address (403 `LOOPBACK_ONLY`).");
  if (op.demoOnly) lines.push("Demo mode only: a Bridge with real accounts answers 404.");
  if (op.publicIngress) lines.push("Served on the public ingress listener when it is enabled.");
  if (op.id === "placeOrder" || op.id === "previewOrder" || op.id === "compatPlaceorder") {
    lines.push("The example is a paper order on the demo paper account. A live order needs every opt-in in docs/guides/safety.md.");
  }
  if (op.idempotent) lines.push("Send an `Idempotency-Key` (8 to 255 characters); a retry with the same key returns the first result.");
  return lines;
}

/** The access and caution notes as one Markdown paragraph list. */
export const noteBlock = (op) => [accessLine(op), ...cautionLines(op)];
