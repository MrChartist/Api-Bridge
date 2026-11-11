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

const j = (v) => JSON.stringify(v, null, 2);

/** Body of a generic webhook alert (sign it with the hook's signing secret). */
export function genericAlert({ orderType = "LIMIT", symbol = "NSE:RELIANCE" } = {}) {
  const m = { symbol, side: "BUY", quantity: 1, id: "my-signal-0001" };
  if (orderType === "LIMIT") m.price = 1402.5;
  return j(m);
}

/**
 * Every snippet group, keyed by integration id. Each item: { title, lang, code }.
 * @param {{ base: string, key?: string | null, account?: string, symbol?: string, folder?: string }} o
 */
export function snippets({ base, key = null, account = "paper", symbol = "NSE:NIFTY", folder = "/path/to/api-bridge" }) {
  const read = key ?? PLACEHOLDER.read;
  const paper = key ?? PLACEHOLDER.paper;
  const url = key ?? PLACEHOLDER.url;
  const host = base.replace(/\/$/, "");
  return {
    webhooks: [
      {
        title: "TradingView strategy alert (paste into the alert's Message box)",
        lang: "json",
        code: JSON.stringify({ symbol: "{{exchange}}:{{ticker}}", side: "{{strategy.order.action}}", quantity: "{{strategy.order.contracts}}", price: "{{strategy.order.price}}", id: "{{strategy.order.id}}", time: "{{timenow}}" }, null, 2),
      },
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
      { title: "Install (inside the api-bridge folder)", lang: "bash", code: `python3 -m venv .venv && . .venv/bin/activate\npip install ./sdk/python\nexport MCB_API_KEY=${paper}` },
      {
        title: "Prices and a paper order",
        lang: "python",
        code: [
          "from mrchartist_bridge import BridgeClient",
          "",
          `bridge = BridgeClient(base_url="${host}")   # key from $MCB_API_KEY`,
          `for q in bridge.ltp(["${symbol}", "NSE:RELIANCE"])["data"]:`,
          `    print(q["symbol"], q["ltp"], q["freshness"]["source"])`,
          "",
          `res = bridge.place_order({"account": "${account}", "symbol": "NSE:RELIANCE", "side": "BUY",`,
          `                          "quantity": 1, "product": "CNC", "orderType": "MARKET"})`,
          `print(res["data"]["orderId"], res["data"]["status"])`,
        ].join("\n"),
      },
    ],
    node: [
      { title: "Install", lang: "bash", code: `cd sdk/node && npm pack\n# in your project:\nnpm install /path/to/mrchartist-bridge-client-0.1.0.tgz ws` },
      {
        title: "Prices, a stream and a paper order (ESM)",
        lang: "js",
        code: [
          `import { BridgeClient } from "@mrchartist/bridge-client";`,
          "",
          `const bridge = new BridgeClient({ baseUrl: "${host}", apiKey: process.env.MCB_API_KEY ?? "${paper}" });`,
          `const { data, errors } = await bridge.ltp(["${symbol}", "NSE:RELIANCE"]);`,
          `for (const q of data) console.log(q.symbol, q.ltp, q.freshness.source);`,
          "",
          `const { data: order } = await bridge.placeOrder({ account: "${account}", symbol: "NSE:RELIANCE", side: "BUY", quantity: 1, product: "CNC", orderType: "MARKET" });`,
          `console.log(order.orderId, order.status);`,
          "",
          `const stream = bridge.stream({ symbols: ["${symbol}"], mode: "ltp" });`,
          `stream.on("tick", (t) => console.log(t.symbol, t.ltp));`,
        ].join("\n"),
      },
    ],
    excel: [
      {
        title: "Excel (Windows): one live value per cell. Put the key in a cell named BridgeKey",
        lang: "excel",
        code: [
          `=VALUE(WEBSERVICE("${host}/xl/ltp?symbol="&ENCODEURL(A2)&"&key="&BridgeKey))`,
          `=VALUE(WEBSERVICE("${host}/xl/quote?symbol="&ENCODEURL(A2)&"&field=changePct&key="&BridgeKey))`,
        ].join("\n"),
      },
      { title: "Your key for the BridgeKey cell", lang: "text", code: url },
      {
        title: "Google Sheets (needs your own tunnel; see integrations/google-sheets)",
        lang: "excel",
        code: `=BRIDGE_LTP("${symbol}")\n=BRIDGE_QUOTE("NSE:RELIANCE", "changePct")`,
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
