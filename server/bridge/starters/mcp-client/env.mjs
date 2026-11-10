// Reads KEY=value lines of .env (next to this file). The environment wins over the file.
import { readFileSync } from "node:fs";

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
  return { ...out, ...process.env };
}
