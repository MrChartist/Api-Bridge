// Reads KEY=value lines of .env (next to this file). The environment wins over the file.
import { readFileSync } from "node:fs";

/**
 * Never send the key through a proxy to this computer. With NODE_USE_ENV_PROXY=1 Node's fetch uses HTTP_PROXY/HTTPS_PROXY, and
 * a proxy cannot reach 127.0.0.1 anyway (it would only see your key). For a loopback address this adds it to NO_PROXY.
 */
export function keepLoopbackDirect(baseUrl) {
  let host;
  try {
    host = new URL(baseUrl).hostname.replace(/^\[|\]$/g, "");
  } catch {
    return;
  }
  if (!(host === "localhost" || host === "::1" || /^127(\.\d{1,3}){3}$/.test(host))) return;
  for (const name of ["NO_PROXY", "no_proxy"]) {
    const have = (process.env[name] ?? "").split(",").map((x) => x.trim()).filter(Boolean);
    for (const h of [host, "127.0.0.1", "localhost", "::1", "[::1]"]) if (!have.includes(h)) have.push(h);
    process.env[name] = have.join(",");
  }
}

export function loadEnv() {
  const out = {};
  try {
    for (const line of readFileSync(new URL("./.env", import.meta.url), "utf8").split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (m && !line.trim().startsWith("#")) out[m[1]] = m[2];
    }
  } catch {
    /* no .env: the environment alone */
  }
  const env = { ...out, ...process.env };
  keepLoopbackDirect(env.BRIDGE_URL ?? "http://127.0.0.1:4300");
  return env;
}
