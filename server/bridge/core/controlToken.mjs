/**
 * Local control token: lets `mc-bridge kill` stop (or release) trading, and `mc-bridge download` run data downloads, on a
 * running Bridge without an API key.
 *
 * While the Bridge listens it keeps a random token in <dataDir>/control.token (owner-only, 0600) and deletes it on a
 * clean stop. A request carrying it is accepted only on routes marked `localControl` (the kill-switch routes and the
 * downloads routes `mc-bridge download` calls; routePolicy.test.mjs pins that list), only from this computer, and acts as
 * the local CLI: admin scope, no account limit. This grants nothing new: whoever can read the data folder can already
 * stop the Bridge, release the kill switch offline (`mc-bridge kill release` with the Bridge stopped) and read or delete
 * every downloaded file. Events, recordings, collections and webhooks do not accept it.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const CONTROL_TOKEN_FILE = "control.token";
const PREFIX = "mcbctl_";

/** @param {string} dataDir */
export const controlTokenPath = (dataDir) => join(dataDir, CONTROL_TOKEN_FILE);

/** Write a fresh token for this run. @param {string} dataDir @returns {string} */
export function writeControlToken(dataDir) {
  const token = PREFIX + randomBytes(32).toString("base64url");
  const file = controlTokenPath(dataDir);
  writeFileSync(file, `${token}\n`, { mode: 0o600 });
  chmodSync(file, 0o600); // writeFileSync's mode applies only when it creates the file
  return token;
}

/** The token of the running Bridge, or null. @param {string} dataDir */
export function readControlToken(dataDir) {
  try {
    const t = readFileSync(controlTokenPath(dataDir), "utf8").trim();
    return t.startsWith(PREFIX) ? t : null;
  } catch {
    return null;
  }
}

/** Remove the token file if it still holds `token` (another run may have replaced it). */
export function removeControlToken(dataDir, token) {
  if (readControlToken(dataDir) === token) rmSync(controlTokenPath(dataDir), { force: true });
}

const digest = (s) => createHash("sha256").update(String(s)).digest();
/** Constant-time comparison. @param {string | null} expected @param {string} given */
export const isControlToken = (expected, given) => typeof expected === "string" && typeof given === "string" && given.startsWith(PREFIX) && timingSafeEqual(digest(expected), digest(given));
