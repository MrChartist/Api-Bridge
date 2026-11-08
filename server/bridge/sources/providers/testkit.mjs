/** Test helpers shared by the provider tests: fixture loading. No network anywhere. */
import { readFileSync } from "node:fs";

/** Parsed JSON of a file under __fixtures__ (for example "yahoo/chart_NSEI_1m.json"). */
export const fixture = (path) => JSON.parse(readFileSync(new URL(`./__fixtures__/${path}`, import.meta.url), "utf8"));

/** The query string of a URL as a plain object. */
export const query = (url) => Object.fromEntries(new URL(url).searchParams);
