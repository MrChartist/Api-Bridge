/**
 * A small tar (ustar) writer and a streaming reader, for backup archives. Node built-ins only (node:zlib does the
 * gzip). Only plain files are written or accepted: no links, devices, directories as entries or extended headers, so
 * a malicious archive has nothing to abuse except a file name, and names are checked by the caller (paths.mjs).
 *
 *   const sink = createTarWriter(writable);   await sink.add("data/keys.json", buffer, { mode: 0o600 });   await sink.end();
 *   await readTar(readable, { onFile(name, size) { return { write(chunk), finish() } } });
 */
const BLOCK = 512;
const END = Buffer.alloc(BLOCK * 2);

/** Fixed-width octal field: zero padded, NUL terminated. */
function octal(value, width) {
  const s = Math.trunc(value).toString(8);
  if (s.length > width - 1) throw new Error("tar field too large");
  return `${s.padStart(width - 1, "0")}\0`;
}

function splitName(name) {
  const bytes = Buffer.byteLength(name);
  if (bytes <= 100) return { name, prefix: "" };
  // ustar: up to 155 bytes of directory prefix and 100 of file name, split at a slash.
  for (let i = name.length - 1; i > 0; i--) {
    if (name[i] !== "/") continue;
    const prefix = name.slice(0, i);
    const rest = name.slice(i + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(rest) <= 100 && rest) return { name: rest, prefix };
  }
  throw new Error(`file name too long for a backup: ${name}`);
}

/** One 512-byte header for a regular file. */
export function tarHeader(name, size, { mode = 0o600, mtime = 0 } = {}) {
  const h = Buffer.alloc(BLOCK);
  const { name: n, prefix } = splitName(name);
  h.write(n, 0, 100, "utf8");
  h.write(octal(mode & 0o777, 8), 100, 8, "ascii");
  h.write(octal(0, 8), 108, 8, "ascii"); // uid
  h.write(octal(0, 8), 116, 8, "ascii"); // gid
  h.write(octal(size, 12), 124, 12, "ascii");
  h.write(octal(Math.max(0, Math.floor(mtime)), 12), 136, 12, "ascii");
  h.write("        ", 148, 8, "ascii"); // checksum counts these as spaces
  h.write("0", 156, 1, "ascii");
  h.write("ustar\0", 257, 6, "ascii");
  h.write("00", 263, 2, "ascii");
  if (prefix) h.write(prefix, 345, 155, "utf8");
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += h[i];
  h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return h;
}

const write = (stream, chunk) =>
  new Promise((resolve, reject) => {
    // The callback runs once the chunk has been handled, so waiting for it is the back-pressure.
    stream.write(chunk, (err) => (err ? reject(err) : resolve()));
  });

/** @param {import("node:stream").Writable} stream */
export function createTarWriter(stream) {
  return {
    /** Add a regular file whose whole content is `data`. */
    async add(name, data, opts = {}) {
      await write(stream, tarHeader(name, data.length, opts));
      if (data.length) await write(stream, data);
      const pad = (BLOCK - (data.length % BLOCK)) % BLOCK;
      if (pad) await write(stream, Buffer.alloc(pad));
    },
    /** Write the end marker and close the stream. */
    end() {
      return new Promise((resolve, reject) => {
        stream.once("error", reject);
        stream.end(END, () => resolve());
      });
    },
  };
}

function field(block, from, len) {
  const raw = block.subarray(from, from + len);
  const nul = raw.indexOf(0);
  return raw.subarray(0, nul < 0 ? raw.length : nul).toString("utf8");
}

function parseOctal(block, from, len, what) {
  const text = field(block, from, len).trim();
  if (!/^[0-7]*$/.test(text)) throw new TarError(`the archive is damaged (bad ${what})`);
  return text === "" ? 0 : Number.parseInt(text, 8);
}

export class TarError extends Error {}

/**
 * Read a tar stream. For each regular file `onFile(name, size)` returns a sink ({ write(chunk), finish() }; either may
 * be async), or null to skip the file. Anything that is not a regular file, a PAX/GNU extension, a bad checksum, a
 * size above `maxFileBytes`, more than `maxEntries` entries or more than `maxTotalBytes` of content throws TarError.
 * @param {AsyncIterable<Buffer>} source
 */
export async function readTar(source, { onFile, maxFileBytes = 2 ** 31, maxTotalBytes = 2 ** 33, maxEntries = 100_000 } = {}) {
  let buf = Buffer.alloc(0);
  let state = "header";
  let sink = null;
  let remaining = 0;
  let padding = 0;
  let entries = 0;
  let total = 0;
  let sawEnd = false;
  const take = (n) => {
    const out = buf.subarray(0, n);
    buf = buf.subarray(n);
    return out;
  };
  for await (const chunk of source) {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    for (;;) {
      if (state === "header") {
        if (buf.length < BLOCK) break;
        const h = take(BLOCK);
        if (h.every((b) => b === 0)) {
          sawEnd = true;
          state = "end";
          continue;
        }
        let sum = 0;
        for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : h[i];
        if (sum !== parseOctal(h, 148, 8, "checksum")) throw new TarError("the archive is damaged (header checksum)");
        const type = String.fromCharCode(h[156] || 48);
        const name = (field(h, 345, 155) ? `${field(h, 345, 155)}/` : "") + field(h, 0, 100);
        if (type !== "0") throw new TarError(`the archive holds something that is not a plain file (${name || "?"}, type ${type}); a Bridge backup never does`);
        const size = parseOctal(h, 124, 12, "size");
        if (size > maxFileBytes) throw new TarError(`${name} is larger than the allowed ${maxFileBytes} bytes`);
        if (++entries > maxEntries) throw new TarError("the archive has too many files");
        total += size;
        if (total > maxTotalBytes) throw new TarError("the archive is larger than the allowed total size");
        sink = onFile(name, size) ?? null;
        remaining = size;
        padding = (BLOCK - (size % BLOCK)) % BLOCK;
        state = remaining > 0 ? "body" : padding ? "pad" : "header";
        if (remaining === 0 && sink) {
          await sink.finish?.();
          sink = null;
        }
      } else if (state === "body") {
        if (buf.length === 0) break;
        const part = take(Math.min(remaining, buf.length));
        remaining -= part.length;
        if (sink) await sink.write(part);
        if (remaining === 0) {
          if (sink) await sink.finish?.();
          sink = null;
          state = padding ? "pad" : "header";
        }
      } else if (state === "pad") {
        if (buf.length < padding) break;
        take(padding);
        state = "header";
      } else {
        // after the end marker: ignore the rest (a second zero block, then gzip/tar padding)
        buf = Buffer.alloc(0);
        break;
      }
    }
  }
  if (!sawEnd || state !== "end") throw new TarError("the archive is cut short (it ends before its end marker)");
}
