// A small glossary: one plain sentence for each technical word the dashboard still has to use, and a "What does this
// mean?" button next to the first use of each word on a page. The button is a real <button> (Tab, Enter and Space work,
// nothing depends on hover); it opens the same popover the rest of the dashboard uses (a sheet on phones). The data and
// the matching are pure; only decorateGlossary() and glossButton() touch the page.

/**
 * `id` is the key, `term` how the word reads in the popover title, `re` finds it in text, `text` is the definition:
 * one or two short sentences, written to be read at about grade 8.
 */
export const GLOSSARY = Object.freeze([
  { id: "quota", term: "Quota", re: /\bquotas?\b/i, text: "A limit on how many requests one key or tool may make. It stops one busy tool from using up everyone's room." },
  { id: "burst", term: "Burst", re: /\bbursts?\b/i, text: "A short rush of requests that is allowed at once, before the steady limit applies." },
  { id: "pooling", term: "Pooling", re: /\bpool(?:ing|ed)\b/i, text: "Your own broker accounts share the work of getting prices. It is off until you accept a notice, and orders never move between accounts." },
  { id: "dataclass", term: "Data class", re: /\bdata class(?:es)?\b/i, text: "How current a price is: realtime (your broker's live feed), delayed (minutes late) or eod (end of the day). Only realtime data is used for orders." },
  { id: "scope", term: "Scope", re: /\bscopes?\b/i, text: "What a key is allowed to do, such as read prices or place practice orders." },
  { id: "fingerprint", term: "Fingerprint", re: /\bfingerprints?\b/i, text: "A short code that identifies a key. The Bridge keeps it instead of the key, so nobody can read your key from it." },
  { id: "endpoint", term: "Endpoint", re: /\bendpoints?\b/i, text: "One address on the Bridge that answers one kind of question, such as prices or orders." },
  { id: "token", term: "Token", re: /\btokens?\b/i, text: "A secret code that proves who you are, like a password that a program can use." },
  { id: "websocket", term: "WebSocket", re: /\bweb ?sockets?\b/i, text: "A connection that stays open, so prices arrive as they change and nobody has to keep asking." },
  { id: "mcp", term: "MCP", re: /\bMCP\b/, text: "A standard way for AI assistants to use tools. The Bridge speaks it, so an assistant can read your data." },
  { id: "webhook", term: "Webhook", re: /\bwebhooks?\b/i, text: "A web address that one program calls to say something happened. An alert sent to a Bridge hook becomes a practice order unless you chose live trading." },
  { id: "idempotency", term: "Idempotency key", re: /\bidempotency(?:-key)?\b/i, text: "A label sent with an order so that sending it twice only places it once." },
  { id: "oauth", term: "OAuth", re: /\bOAuth\b/i, text: "A login where you approve access on your broker's own website, so you never type your password here." },
  { id: "json", term: "JSON", re: /\bJSON\b/, text: "A plain text format that programs use to pass data to each other." },
  { id: "latency", term: "Latency", re: /\blatency\b/i, text: "How long an answer takes to arrive." },
  { id: "throttle", term: "Throttled", re: /\bthrottl(?:e|ed|ing)\b/i, text: "Held back or slowed down so a tool stays inside its limit." },
  { id: "upstream", term: "Upstream", re: /\bupstream\b/i, text: "The broker or data source the Bridge asks, as opposed to your own tools that ask the Bridge." },
  { id: "fallback", term: "Fallback", re: /\bfall ?back\b/i, text: "A second source of prices for when your main one cannot answer. It is labelled and never feeds an order (it is not a file backup)." },
  { id: "killswitch", term: "Kill switch", re: /\bkill switch\b/i, text: "A button that stops every new order from every tool at once. Cancelling orders still works." },
  { id: "staticip", term: "Static IP", re: /\bstatic IP\b/i, text: "A fixed internet address that your broker has on record. Some brokers accept orders only from it." },
  { id: "paper", term: "Paper trading", re: /\bpaper (?:trading|orders?)\b/i, text: "Practice trading with pretend money. Nothing reaches the market." },
  { id: "delayed", term: "Delayed", re: /\bdelayed\b/i, text: "Prices that arrive some minutes after the market. Free sources are often delayed, so they are never used for orders." },
  { id: "hashchain", term: "Hash chain", re: /\bhash chain\b/i, text: "A record in which every line depends on the one before it, so any change would show." },
  { id: "sdk", term: "SDK", re: /\bSDKs?\b/, text: "Ready-made code for a programming language that talks to the Bridge for you." },
  { id: "afl", term: "AFL", re: /\bAFL\b/, text: "AmiBroker's own formula language." },
  { id: "ltp", term: "LTP", re: /\bLTP\b/, text: "Last traded price: the price of the most recent trade." },
  { id: "cli", term: "CLI", re: /\bCLI\b|\bcommand line\b/i, text: "The command line: typing commands in a terminal window." },
  { id: "tunnel", term: "Tunnel", re: /\btunnel\b/i, text: "A secure link that lets a website reach a program on your own computer." },
]);

/**
 * Words the guides use that the dashboard does not decorate (no `re`): they are only in docs/guides/glossary.md. The page
 * is generated from GLOSSARY and this list (scripts/gen-glossary.mjs), so the app and the guides never disagree.
 */
export const DOC_TERMS = Object.freeze([
  { id: "freshness", term: "Freshness", text: "The label on every price: where it came from (`source`), how old it is (`ageMs`), whether it is `stale`, and its data class. Read it before you trust a number." },
  { id: "stale", term: "Stale", text: "A price older than the Bridge accepts for that kind of data, or from a feed that has gone quiet. It is marked `stale: true` and is never used for an order." },
  { id: "realtime", term: "Realtime, delayed, eod", text: "The three data classes. Realtime comes from your own broker's live feed. Delayed arrives some minutes late. Eod is end-of-day data. Only realtime data feeds orders, risk checks, paper fills and alerts." },
  { id: "demo", term: "Demo mode", text: "`start --demo` runs the Bridge with sample prices made on your computer and one paper account (`demo-paper`). Nothing reaches a broker, and every answer says so." },
  { id: "symbol", term: "Canonical symbol", text: "The one way the Bridge writes an instrument, whichever broker is behind it: `EXCHANGE:NAME`, such as `NSE:RELIANCE`, and for derivatives `NFO:NIFTY-2026-12-29-FUT` or `NFO:NIFTY-2026-12-29-25000-CE` (the dates here only show the format)." },
  { id: "expiry", term: "Expiry", text: "The date a futures or options contract ends. It is part of the symbol (`YYYY-MM-DD`). A contract that has expired is `SYMBOL_NOT_FOUND`, so list live ones with `GET /v1/expiries`." },
  { id: "strike", term: "Strike", text: "The price an option is written at. The symbol carries it before CE or PE." },
  { id: "cepe", term: "CE and PE", text: "Call (CE) and put (PE): the two kinds of option." },
  { id: "atm", term: "ATM (at the money)", text: "The strike nearest the current price of the underlying. A collection works it out from a realtime price each time it is resolved, and says so when the price is delayed or stale." },
  { id: "lot", term: "Lot", text: "The smallest batch a derivative trades in. `lots` counts batches, `quantity` counts units; the safety limit is also in lots." },
  { id: "product", term: "Product (CNC, INTRADAY, MARGIN, MTF)", text: "How an order is held. `CNC` is delivery shares, `INTRADAY` (also written `MIS`) must close the same day, `MARGIN` (also `NRML`) carries a derivative overnight, and `MTF` is margin-funded delivery. The Bridge accepts the common spellings and shows what it used." },
  { id: "tick", term: "Tick", text: "One price update on a stream. A slow reader may skip some; the newest always arrives." },
  { id: "snapshot", term: "Snapshot", text: "The latest known price for each symbol you subscribed to, sent first when a stream opens, before the live ticks." },
  { id: "ticket", term: "Ticket and confirmation code", text: "An order that an AI assistant or a hook prepared waits as a ticket until you approve it on the computer running the Bridge. Approving gives a one-time confirmation code that lets exactly that order be sent, once." },
  { id: "cursor", term: "Cursor", text: "A number that marks your place in the Bridge's event list. Ask for events `since` a cursor to catch up without missing or repeating any." },
  { id: "sse", term: "SSE (server-sent events)", text: "A one-way live feed over an ordinary web request. The Bridge uses it for events; a WebSocket is the two-way kind." },
  { id: "hmac", term: "HMAC signature", text: "A code made from a message and a shared secret. A receiver recomputes it to check that a webhook came from the Bridge and was not changed on the way." },
  { id: "deadletter", term: "Dead letter", text: "A webhook delivery that kept failing and was given up on. It is kept in a list so you can retry it or clear it." },
  { id: "dataset", term: "Dataset", text: "Downloaded history kept under a name. Updating it fetches only the bars after the last stored one." },
  { id: "collection", term: "Collection", text: "A named, tagged list of instruments, or an option universe that works out its symbols when you use it. Downloads, recordings, sheets and Python can all use one instead of a pasted list." },
  { id: "readiness", term: "Readiness", text: "A check, per live-enabled account, of whether a live order could be sent right now: broker session, registered address, headroom and the kill switch. It never changes anything." },
  { id: "ingress", term: "Ingress and egress", text: "Ingress is traffic coming in to the Bridge from outside, which is off unless you open the separate webhook or Sheets listener. Egress is the internet address your broker sees when the Bridge calls out." },
  { id: "masterkey", term: "Master key", text: "The key that encrypts the broker logins the Bridge saves. Keep it outside the data folder and back it up separately; without it saved logins cannot be read (you can log in again)." },
  { id: "controltoken", term: "Control token", text: "A file in the data folder that lets the command line on this computer do a few things (such as the kill switch) without a key. It works only from this computer." },
  { id: "loopback", term: "Loopback", text: "The address `127.0.0.1`, which only this computer can reach. Admin actions work only from there, even when a tunnel forwards other requests." },
]);

/** The entry for an id. */
export const glossaryEntry = (id) => GLOSSARY.find((g) => g.id === id) ?? null;

/** Which terms a piece of text uses (ids, in the order of the glossary). Pure. */
export const termsIn = (text) => GLOSSARY.filter((g) => g.re.test(String(text ?? ""))).map((g) => g.id);

/** The label a screen reader hears on the button. */
export const glossLabel = (entry) => `What does “${entry.term}” mean?`;

// ── In the page ──

const SKIP = "script,style,pre,code,textarea,input,select,button,a,summary,label,svg,h1,[role=tab],[role=radio],[role=option],[data-gloss],[contenteditable],.segmented,.palette,.snip,.once-value,.sr-only,[aria-live],[role=status],[role=progressbar],[hidden]";

/** The small "?" that opens a term's meaning. Returns the wrapper (term text + button). */
export function glossButton(entry, text = entry.term) {
  const wrap = document.createElement("span");
  wrap.className = "gl";
  wrap.dataset.gloss = entry.id;
  const word = document.createElement("span");
  word.textContent = text;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "gl-btn";
  btn.textContent = "?";
  btn.setAttribute("aria-label", glossLabel(entry));
  btn.setAttribute("aria-haspopup", "dialog");
  btn.addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    const { sheetPopover, h } = await import("./app.js");
    sheetPopover({ trigger: btn, title: entry.term, cls: "gl-pop", body: h("p", { class: "gl-text" }, entry.text) });
    btn.setAttribute("aria-expanded", "true");
  });
  wrap.append(word, btn);
  return wrap;
}

/**
 * Put a "?" after the first use of every glossary word inside `root` (once per word per page). Safe to call again: a
 * word that already has one is left alone, and links, buttons, tabs, code and live numbers are never touched.
 * @returns {number} how many were added
 */
export function decorateGlossary(root) {
  if (!root || typeof document === "undefined") return 0;
  const have = new Set([...root.querySelectorAll("[data-gloss]")].map((e) => e.dataset.gloss));
  const todo = GLOSSARY.filter((g) => !have.has(g.id));
  if (!todo.length) return 0;
  let added = 0;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.textContent.trim().length > 2 && !n.parentElement?.closest(SKIP) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    for (const g of todo) {
      if (have.has(g.id) || !node.isConnected) continue;
      const m = g.re.exec(node.textContent);
      if (!m) continue;
      const text = node.textContent;
      const before = text.slice(0, m.index);
      const after = text.slice(m.index + m[0].length);
      const piece = glossButton(g, m[0]);
      const tail = document.createTextNode(after);
      node.parentNode.replaceChild(piece, node);
      piece.before(document.createTextNode(before));
      piece.after(tail);
      have.add(g.id);
      added++;
      // The rest of this text is a new node: other words may still match in it.
      nodes.push(tail);
    }
  }
  return added;
}

/** Keep #content decorated as it changes (pages draw their data after the page itself). One observer, debounced. */
export function watchGlossary(root) {
  if (!root || typeof MutationObserver === "undefined" || root.__gloss) return;
  let timer = 0;
  const run = () => {
    timer = 0;
    obs.disconnect();
    try {
      decorateGlossary(root);
    } finally {
      obs.observe(root, { childList: true, subtree: true });
    }
  };
  const obs = new MutationObserver(() => {
    if (!timer) timer = setTimeout(run, 200);
  });
  root.__gloss = obs;
  obs.observe(root, { childList: true, subtree: true });
  run();
}
