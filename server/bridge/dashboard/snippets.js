// Copy-paste snippets for each integration. Pure functions (no DOM), so they can be tested under Node.
// `key` is either a key the person just created on this page or a placeholder; the admin key is never inserted.

export const PLACEHOLDER = {
  read: "mcb_YOUR_READ_KEY",
  paper: "mcb_YOUR_PAPER_KEY",
  url: "mcb_YOUR_URL_KEY",
};

/** What key each integration needs, for the "Create a key for this" button (webhooks need none: the URL is the credential). */
export const KEY_PRESETS = Object.freeze({
  python: { label: "Python scripts", scopes: ["paper"], clientKind: "script" },
  node: { label: "Node scripts", scopes: ["paper"], clientKind: "script" },
  excel: { label: "Excel prices", scopes: ["read"], clientKind: "excel", allowQuery: true, expiresDays: 90 },
  amibroker: { label: "AmiBroker", scopes: ["read"], clientKind: "other", allowQuery: true, expiresDays: 90 },
  claude: { label: "Claude (MCP)", scopes: ["read"], clientKind: "mcp" },
  chatgpt: { label: "OpenAI tools", scopes: ["read"], clientKind: "mcp" },
  rest: { label: "curl / REST", scopes: ["read"], clientKind: "script" },
});

/**
 * The `POST /v1/keys` body for an integration preset (KEY_PRESETS): its scopes and kind, on every account unless `accounts` says
 * otherwise, with the expiry and the "allow the key in the address" flag the preset (or the caller) asks for. Pure.
 */
export function presetKeyBody(preset, { label = preset.label, accounts = "*", expiresDays = preset.expiresDays, allowQuery = preset.allowQuery, now = new Date() } = {}) {
  const body = { label, scopes: [...preset.scopes], accounts, clientKind: preset.clientKind };
  if (allowQuery) body.allowQuery = true;
  if (expiresDays) body.expiresAt = new Date(now.getTime() + expiresDays * 86_400_000).toISOString();
  return body;
}

const j = (v) => JSON.stringify(v, null, 2);
/** A folder path as a shell word: quoted only when it has a space. */
const sh = (path) => (/\s/.test(path) ? `"${path}"` : path);

/** Body of a generic webhook alert (sign it with the hook's signing secret). */
export function genericAlert({ orderType = "LIMIT", symbol = "NSE:RELIANCE" } = {}) {
  const m = { symbol, side: "BUY", quantity: 1, id: "my-signal-0001" };
  if (orderType === "LIMIT") m.price = 1402.5;
  return j(m);
}

/**
 * The alert message for a TradingView hook (what the hook creator shows with the real passphrase). The {{ }} words are
 * TradingView's own placeholders; it fills them in when the alert fires.
 * @param {{ strategy?: boolean, passphrase?: string }} [o]
 */
export function tradingViewAlert({ strategy = false, passphrase = "YOUR_PASSPHRASE" } = {}) {
  const side = strategy ? '"{{strategy.order.action}}"' : '"buy"';
  const lots = strategy ? "{{strategy.order.contracts}}" : "1";
  const price = strategy ? "{{strategy.order.price}}" : "{{close}}";
  const id = strategy ? '"{{strategy.order.id}}"' : '"my-alert"';
  const position = strategy ? '  "marketPosition": "{{strategy.market_position}}",\n  "positionSize": {{strategy.market_position_size}},\n' : "";
  return `{\n  "symbol": "{{exchange}}:{{ticker}}",\n  "side": ${side},\n  "lots": ${lots},\n  "orderType": "limit",\n  "price": ${price},\n  "product": "MIS",\n  "mode": "paper",\n${position}  "id": ${id},\n  "time": "{{timenow}}",\n  "passphrase": "${passphrase}"\n}`;
}

/**
 * Every snippet group, keyed by integration id. Each item: { title, lang, code }.
 * `orders: false` (a read-only key) leaves the paper-order lines out of the Python and Node examples, which such a key could not run.
 * @param {{ base: string, key?: string | null, account?: string, symbol?: string, folder?: string, orders?: boolean }} o
 */
export function snippets({ base, key = null, account = "paper", symbol = "NSE:NIFTY", folder = "/path/to/api-bridge-v2", orders = true }) {
  const read = key ?? PLACEHOLDER.read;
  const paper = key ?? PLACEHOLDER.paper;
  const url = key ?? PLACEHOLDER.url;
  const host = base.replace(/\/$/, "");
  return {
    webhooks: [
      { title: "TradingView alert message, plain alert (paper)", lang: "json", code: tradingViewAlert() },
      { title: "TradingView alert message, strategy alert (paper)", lang: "json", code: tradingViewAlert({ strategy: true }) },
      { title: "Generic alert body (JSON)", lang: "json", code: genericAlert() },
      {
        title: "Send a signed generic alert (bash + openssl)",
        lang: "bash",
        code: [
          `URL="${host}/hooks/generic/<token from the webhook URL>"`,
          `SECRET="<signing secret shown once when the hook was created>"`,
          `BODY='{"symbol":"NSE:RELIANCE","side":"BUY","quantity":1,"id":"my-signal-0001","price":1402.5}'`,
          `T=$(date +%s)`,
          `SIG=$(printf '%s' "$T.$BODY" | openssl dgst -sha256 -hmac "$SECRET" | sed 's/^.* //')`,
          `curl -sS -X POST "$URL" -H "Content-Type: application/json" -H "X-MCB-Signature: t=$T,v1=$SIG" -d "$BODY"`,
        ].join("\n"),
      },
      { title: "GoCharting alert message (plain text)", lang: "text", code: "BUY NSE:RELIANCE 1 @ 1402.5 INTRADAY" },
    ],
    python: [
      // The Python client is not on PyPI: it installs from this repository's sdk/python folder (import name: mrchartist_bridge).
      { title: "Install from your API Bridge folder (it is not on PyPI)", lang: "bash", code: `python3 -m venv .venv && . .venv/bin/activate\npip install ${sh(`${folder}/sdk/python`)}\nexport MCB_API_KEY=${paper}` },
      {
        title: orders ? "Prices and a paper order" : "Prices",
        lang: "python",
        code: [
          "from mrchartist_bridge import BridgeClient",
          "",
          `bridge = BridgeClient(base_url="${host}")   # key from $MCB_API_KEY`,
          `for q in bridge.ltp(["${symbol}", "NSE:RELIANCE"])["data"]:`,
          `    print(q["symbol"], q["ltp"], q["freshness"]["source"])`,
          ...(orders
            ? [
                "",
                `res = bridge.place_order({"account": "${account}", "symbol": "NSE:RELIANCE", "side": "BUY",`,
                `                          "quantity": 1, "product": "CNC", "orderType": "MARKET"})`,
                `print(res["data"]["orderId"], res["data"]["status"])`,
              ]
            : []),
        ].join("\n"),
      },
      {
        title: "Order and data events: ask now and then, or listen (no polling of prices)",
        lang: "python",
        code: [
          "from mrchartist_bridge import BridgeClient",
          "",
          `bridge = BridgeClient(base_url="${host}")   # key from $MCB_API_KEY`,
          `page = bridge.events.poll(topics="order.*")        # the newest order events`,
          `for ev in page:`,
          `    print(ev.topic, ev.data)`,
          `# next time: bridge.events.poll(since=page.cursor, topics="order.*")`,
          "",
          `# or wait for them as they happen (reconnects by itself and resumes from its cursor):`,
          `for ev in bridge.events.subscribe(["order.*", "download.*"]):`,
          `    print(ev.topic, ev.cursor)`,
          "",
          `# a program that RECEIVES signed messages checks each one: Developers > Events adds the receiver`,
          `# ok = bridge.events.verify_signature(secret, raw_body, request_headers)`,
        ].join("\n"),
      },
    ],
    node: [
      // The Node client (@mrchartist/bridge-client) is private: it is packed from this repository's sdk/node folder.
      { title: "Install from your API Bridge folder (it is not on npm)", lang: "bash", code: `cd ${sh(`${folder}/sdk/node`)} && npm pack\n# then, in your project (ws is only needed to stream on Node 20):\nnpm install ${sh(`${folder}/sdk/node/mrchartist-bridge-client-0.2.0.tgz`)} ws` },
      {
        title: orders ? "Prices, a stream and a paper order (ESM)" : "Prices and a stream (ESM)",
        lang: "js",
        code: [
          `import { BridgeClient } from "@mrchartist/bridge-client";`,
          "",
          `const bridge = new BridgeClient({ baseUrl: "${host}", apiKey: process.env.MCB_API_KEY ?? "${paper}" });`,
          `const { data, errors } = await bridge.ltp(["${symbol}", "NSE:RELIANCE"]);`,
          `for (const q of data) console.log(q.symbol, q.ltp, q.freshness.source);`,
          "",
          ...(orders
            ? [
                `const { data: order } = await bridge.placeOrder({ account: "${account}", symbol: "NSE:RELIANCE", side: "BUY", quantity: 1, product: "CNC", orderType: "MARKET" });`,
                `console.log(order.orderId, order.status);`,
                "",
              ]
            : []),
          `const stream = bridge.stream({ symbols: ["${symbol}"], mode: "ltp" });`,
          `stream.on("tick", (t) => console.log(t.symbol, t.ltp));`,
        ].join("\n"),
      },
      {
        title: "Order and data events: ask now and then, or listen (no polling of prices)",
        lang: "js",
        code: [
          `import { BridgeClient } from "@mrchartist/bridge-client";`,
          "",
          `const bridge = new BridgeClient({ baseUrl: "${host}", apiKey: process.env.MCB_API_KEY ?? "${paper}" });`,
          `const page = await bridge.events.poll({ topics: "order.*" });   // the newest order events`,
          `for (const ev of page.events) console.log(ev.topic, ev.data);`,
          `// next time: bridge.events.poll({ since: page.cursor, topics: "order.*" })`,
          "",
          `// or wait for them as they happen (reconnects by itself and resumes from its cursor):`,
          `for await (const ev of bridge.events.subscribe({ topics: ["order.*", "download.*"] })) console.log(ev.topic, ev.cursor);`,
          "",
          `// a program that RECEIVES signed messages checks each one: Developers > Events adds the receiver`,
          `// const ok = bridge.events.verifySignature(secret, rawBodyBuffer, req.headers);`,
        ].join("\n"),
      },
    ],
    excel: [
      {
        title: "Excel for Windows: one value in one cell (the key goes in a cell named BridgeKey). For a whole list, download the workbook or use the link further down",
        lang: "excel",
        code: [
          `=VALUE(WEBSERVICE("${host}/xl/ltp?symbol="&ENCODEURL(A2)&"&key="&BridgeKey))`,
          `=VALUE(WEBSERVICE("${host}/xl/quote?symbol="&ENCODEURL(A2)&"&field=changePct&key="&BridgeKey))`,
        ].join("\n"),
      },
      { title: "Your key for the BridgeKey cell", lang: "text", code: url },
      {
        title: "Excel for Mac, if you cannot use Power Query: a whole list in one link (Data, From Web). The link has your key in it, so keep it on this computer and do not share it. Not for Google Sheets. Each row says how current it is",
        lang: "text",
        code: `${host}/xl/quotes?symbols=NSE:RELIANCE,NSE:TCS,NSE:NIFTY&fields=ltp,chg,pct,volume&format=csv&key=${url}`,
      },
      {
        title: "Google Sheets: needs your own tunnel and the Apps Script from Integrations (Excel and Sheets), with the key in a script property. Never put the key in an IMPORTDATA link",
        lang: "excel",
        code: `=BRIDGE_QUOTES(A5:A30)\n=BRIDGE_QUOTE("NSE:RELIANCE", "pct")`,
      },
    ],
    amibroker: [
      {
        title: "AFL (copy integrations/amibroker/mrchartist-bridge.afl to Formulas\\Include)",
        lang: "afl",
        code: [
          "#include_once <mrchartist-bridge.afl>",
          "",
          `ltp = McbLtp("${symbol}");`,
          `chg = McbQuote("NSE:RELIANCE", "changePct");`,
          `Title = "${symbol.split(":").pop()} " + NumToStr(ltp, 1.2) + "   RELIANCE " + NumToStr(chg, 1.2) + "%";`,
        ].join("\n"),
      },
      { title: "Set the key once (Windows, then restart AmiBroker)", lang: "bat", code: `setx MCB_AMIBROKER_KEY ${url}\nsetx MCB_BRIDGE_URL ${host}` },
    ],
    claude: [
      {
        title: "Claude Desktop: claude_desktop_config.json",
        lang: "json",
        code: j({ mcpServers: { "mr-chartist-bridge": { command: "node", args: [`${folder}/bin/mc-bridge.mjs`, "mcp"], env: { MCB_API_KEY: read, MCB_BRIDGE_URL: host } } } }),
      },
      {
        title: "Claude Code",
        lang: "bash",
        code: `claude mcp add mr-chartist-bridge --env MCB_API_KEY=${read} --env MCB_BRIDGE_URL=${host} -- node ${folder}/bin/mc-bridge.mjs mcp\n# or over HTTP:\nclaude mcp add --transport http mr-chartist-bridge ${host}/mcp --header "Authorization: Bearer ${read}"`,
      },
    ],
    chatgpt: [
      { title: "OpenAI tool schemas for your own script (function calling)", lang: "bash", code: "npm run -s bridge -- openai-tools > tools.json            # Responses API\nnpm run -s bridge -- openai-tools --format chat > tools.json   # Chat Completions" },
      {
        title: "Run each tool call against the Bridge",
        lang: "python",
        code: [
          "import json, urllib.request",
          "",
          "def call_bridge_tool(name, arguments):",
          `    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": name, "arguments": arguments}}).encode()`,
          `    req = urllib.request.Request("${host}/mcp", data=body, method="POST", headers={`,
          `        "Authorization": "Bearer ${read}", "Content-Type": "application/json", "Accept": "application/json, text/event-stream"})`,
          "    with urllib.request.urlopen(req) as r:",
          "        return json.loads(r.read())[\"result\"]",
        ].join("\n"),
      },
    ],
    rest: [
      {
        title: "curl",
        lang: "bash",
        code: [
          `export MCB_API_KEY=${read}`,
          `curl -H "Authorization: Bearer $MCB_API_KEY" "${host}/v1/quotes?symbols=${symbol},NSE:RELIANCE"`,
          `curl -H "Authorization: Bearer $MCB_API_KEY" "${host}/v1/optionchain?underlying=NIFTY&expiry=<YYYY-MM-DD>&strikes=10&greeks=true"`,
          `curl -H "Authorization: Bearer $MCB_API_KEY" "${host}/v1/history?symbol=${symbol}&interval=5m&countback=300"`,
        ].join("\n"),
      },
    ],
  };
}

// ── Webhook panel helpers (pure: the DOM code in views.js only draws what these return) ──

/**
 * The address to paste into TradingView: the hook's secret path on the public address the person types (their tunnel
 * or domain). Without one, the local address, which only works on this computer.
 * @param {{ path: string, localUrl?: string | null, publicBase?: string | null }} o
 * @returns {{ url: string, isPublic: boolean, problem: string | null }}
 */
export function finalHookUrl({ path, localUrl = null, publicBase = "" }) {
  const raw = String(publicBase ?? "").trim();
  if (!raw) return { url: localUrl ?? path, isPublic: false, problem: null };
  const m = /^(https?):\/\/([A-Za-z0-9.-]+)(?::(\d{1,5}))?\/?$/.exec(raw);
  if (!m) return { url: localUrl ?? path, isPublic: false, problem: "Type the address as https://your-name.example.com, with nothing after the name." };
  const [, scheme, host, port] = m;
  if (/^(localhost|127\.|0\.0\.0\.0)/.test(host)) return { url: localUrl ?? path, isPublic: false, problem: "That address only works on this computer. TradingView needs an address on the internet." };
  if (port && port !== "80" && port !== "443") return { url: `${scheme}://${host}:${port}${path}`, isPublic: true, problem: "TradingView only sends to port 80 or 443. Use an address without another port." };
  return { url: `${scheme}://${host}${port ? `:${port}` : ""}${path}`, isPublic: true, problem: null };
}

/** How one alert ended, as a short word for a pill and its tone. */
const OUTCOME_WORDS = Object.freeze({
  placed: ["Placed", "ok"],
  queued: ["Waiting", ""],
  processing: ["Checking", ""],
  awaiting_confirmation: ["Needs you", "warn"],
  duplicate: ["Repeat", ""],
  stale: ["Too old", "warn"],
  refused: ["Unreadable", "warn"],
  rejected: ["Not placed", "bad"],
  failed: ["Failed", "bad"],
  outcome_unknown: ["Check broker", "bad"],
  dropped: ["Not run", "bad"],
});

/**
 * @param {{ outcome: string, summary?: string | null, reason?: string | null }} e a signal from GET /v1/hooks/{id}/signals
 * @returns {{ word: string, tone: string, text: string }}
 */
export function outcomeView(e) {
  const [word, tone] = OUTCOME_WORDS[e?.outcome] ?? ["Unknown", "warn"];
  return { word, tone, text: e?.summary || e?.reason || "" };
}

/** "3 placed, 1 not placed, 2 wrong passphrases" from the counts of a signals answer; "" when there is nothing to say. */
export function countsLine(counts = {}) {
  const n = (k) => Number(counts[k]) || 0;
  const part = (k, one, many) => (n(k) ? `${n(k)} ${n(k) === 1 ? one : many}` : null);
  return [
    part("placed", "placed", "placed"),
    part("awaitingConfirmation", "waiting for you", "waiting for you"),
    part("duplicate", "repeat", "repeats"),
    part("rejected", "not placed", "not placed"),
    part("stale", "too old", "too old"),
    part("badRequest", "unreadable", "unreadable"),
    part("authFailed", "wrong passphrase", "wrong passphrases"),
    part("addressRefused", "from an address that is not allowed", "from addresses that are not allowed"),
  ].filter(Boolean).join(", ");
}

const ago = (ms) => {
  const m = Math.floor(ms / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"} ago`;
  const hrs = Math.floor(m / 60);
  if (hrs < 48) return `${hrs} hour${hrs === 1 ? "" : "s"} ago`;
  return `${Math.floor(hrs / 24)} days ago`;
};

/**
 * What to tell the person about a hook that may have gone quiet.
 * @param {{ lastSignalAt: string | null, createdAt: string | null }} hook
 * @param {number} nowMs
 * @returns {{ state: "new" | "never" | "recent" | "quiet", tone: string, text: string, hint: string | null }}
 */
export function silentHint(hook, nowMs) {
  const last = hook?.lastSignalAt ? Date.parse(hook.lastSignalAt) : Number.NaN;
  const made = hook?.createdAt ? Date.parse(hook.createdAt) : Number.NaN;
  if (Number.isFinite(last)) {
    const age = nowMs - last;
    if (age > 3 * 86_400_000) {
      return { state: "quiet", tone: "warn", text: `Quiet for ${Math.floor(age / 86_400_000)} days`, hint: "No alert has arrived for a while. If one should have, open the alert in TradingView and check its log and that it is still on, and check that your tunnel is running." };
    }
    return { state: "recent", tone: "", text: `Last alert ${ago(age)}`, hint: null };
  }
  const age = Number.isFinite(made) ? nowMs - made : 0;
  if (age < 15 * 60_000) return { state: "new", tone: "", text: "No alert received yet", hint: "Send a test alert to check the hook, then create the alert in TradingView." };
  return { state: "never", tone: "warn", text: `No alert received since it was made ${ago(age)}`, hint: "Nothing has reached this hook. Check the address in TradingView's alert (Notifications, Webhook URL), that your tunnel is running, and that the alert has fired." };
}
