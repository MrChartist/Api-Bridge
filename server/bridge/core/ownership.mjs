/**
 * Ownership of per-key records (saved scans, alert rules, guards and any later rule store).
 *
 * A record belongs to the API key that created it (`rec.keyId`; null for records made from this computer without a
 * key). A person at this computer (principal "local") and any key with the `admin` scope see every record; any other
 * key sees only its own. Routes answer NOT_FOUND, never "forbidden", for a record the caller does not own, so ids of
 * other keys' records do not leak.
 */

/**
 * Whether the caller sees every key's records.
 * @param {{ principal?: { kind?: string }, scopes?: { has?(s: string): boolean } }} ctx
 */
export const seesAll = (ctx) => ctx?.principal?.kind === "local" || ctx?.scopes?.has?.("admin") === true;

/**
 * Whether the caller may see and change `rec`.
 * @param {{ principal?: { kind?: string }, scopes?: { has?(s: string): boolean }, key?: { id?: string } | null }} ctx
 * @param {{ keyId?: string | null }} rec
 */
export const owns = (ctx, rec) => seesAll(ctx) || (rec?.keyId ?? null) === (ctx?.key?.id ?? null);

/**
 * The owner id to store on a new record made by this caller.
 * @param {{ key?: { id?: string } | null }} ctx
 * @returns {string | null}
 */
export const ownerKeyId = (ctx) => ctx?.key?.id ?? null;
