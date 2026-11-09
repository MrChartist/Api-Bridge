// Before you paste anything into Google: do the key and the route work?   node check.mjs
// It makes the same request the Apps Script makes (GET /xl/quotes, key in the Authorization header).
import { readFileSync } from "node:fs";

function loadEnv() {
  const out = {};
  try {
    for (const line of readFileSync(new URL("./.env", import.meta.url), "utf8").split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (m && !line.trim().startsWith("#")) out[m[1]] = m[2];
    }
  } catch {
    /* no .env */
  }
  return { ...out, ...process.env };
}

const env = loadEnv();
const base = (env.BRIDGE_URL ?? "http://127.0.0.1:4300").replace(/\/+$/, "");
if (!env.BRIDGE_KEY) {
  console.error("No BRIDGE_KEY in .env. Make one with: mc-bridge keys create --label sheets --scope read --expires 30d");
  process.exit(1);
}
try {
  const res = await fetch(`${base}/xl/quotes?symbols=NSE:RELIANCE,NSE:NIFTY&fields=ltp,chg,pct`, { headers: { Authorization: `Bearer ${env.BRIDGE_KEY}` } });
  const text = await res.text();
  if (res.ok) {
    console.log(text.trim());
    console.log("\nThe key and the route work. The Apps Script asks for the same table.");
  } else {
    console.error(`The Bridge answered ${res.status}:\n${text.trim().slice(0, 300)}`);
    process.exitCode = 1;
  }
} catch (err) {
  console.error(`Could not reach the Bridge at ${base}. Is it running? (${err.cause?.code ?? err.message})`);
  process.exitCode = 1;
}
