// Hashing is injected, so the host can use a fast native implementation while the package stays
// free of platform code (docs/adr/0007). A pure-TypeScript fallback is built in.
import { sha256Hex } from './sha256.js';
export const PURE_HASH = { sha256Hex };
