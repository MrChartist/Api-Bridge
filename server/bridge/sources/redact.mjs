/**
 * The forms an API key can take when a vendor, a proxy or a library echoes it back, so a message that carries one is
 * scrubbed as well as one that carries the key verbatim:
 *
 *   - the key itself;
 *   - URL-encoded (`encodeURIComponent`, upper and lower case hex, and `+` for a space as a form post writes it);
 *   - base64 and base64url, the part of the encoding that depends only on the key (so `Authorization: Basic <base64 of
 *     user:key>` and a key embedded in a larger base64 value are caught whatever comes before it), with and without
 *     padding.
 *
 * Pure and small on purpose: no regular expression is built from the key, so a key with special characters cannot
 * break the scrub or cost time. Keys shorter than 4 characters are never redacted (too short to tell from text).
 */

const MIN_KEY = 4;
const MIN_FORM = 6;
const MAX_KEY = 512;

/** The part of base64(prefix of `o` filler bytes + key) that depends on the key bytes alone (no filler, no following bytes). */
function pureBase64(key, o, alphabet) {
  const bytes = Buffer.concat([Buffer.alloc(o, 0x20), Buffer.from(key, "utf8")]);
  let enc = bytes.toString(alphabet === "url" ? "base64url" : "base64").replace(/=+$/, "");
  const start = Math.ceil((o * 8) / 6);
  const end = Math.floor((bytes.length * 8) / 6);
  enc = enc.slice(start, end);
  return enc;
}

/** Every string a key may appear as, longest first so a longer form is removed before a shorter one inside it. */
export function secretForms(key) {
  if (typeof key !== "string" || key.length < MIN_KEY || key.length > MAX_KEY) return [];
  const forms = new Set([key]);
  const enc = encodeURIComponent(key);
  forms.add(enc);
  forms.add(enc.replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase()));
  forms.add(enc.replace(/%20/gi, "+"));
  forms.add(encodeURI(key));
  for (let o = 0; o < 3; o += 1) {
    for (const alphabet of ["std", "url"]) {
      const p = pureBase64(key, o, alphabet);
      if (p.length >= MIN_FORM) forms.add(p);
    }
  }
  return [...forms].filter((f) => f.length >= MIN_FORM || f === key).sort((a, b) => b.length - a.length);
}

/** `text` with every form of every key in `keys` replaced by `mask`. */
export function scrubSecrets(text, keys, mask = "***") {
  let out = String(text ?? "");
  for (const key of keys ?? []) for (const form of secretForms(key)) if (out.includes(form)) out = out.split(form).join(mask);
  return out;
}
