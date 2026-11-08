/**
 * A fake plugin process for host tests: no real process, no network. `fakeSpawn()` returns a `spawn` replacement that
 * records how it was called and hands out FakeChild objects the test scripts.
 */
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

export class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.pid = 4242;
    this.killed = [];
    this.received = [];
    this.exited = false;
    let buf = "";
    this.stdin.on("data", (d) => {
      buf += d.toString("utf8");
      let i;
      while ((i = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        const msg = JSON.parse(line);
        this.received.push(msg);
        this.onMessage?.(msg, this);
      }
    });
  }

  /** The child writes a protocol message (an object) or a raw string to stdout. */
  say(msg) {
    this.stdout.write(typeof msg === "string" ? msg : `${JSON.stringify(msg)}\n`);
  }

  kill(signal = "SIGTERM") {
    this.killed.push(signal);
    queueMicrotask(() => this.exit(null, signal));
    return true;
  }

  exit(code = 0, signal = null) {
    if (this.exited) return;
    this.exited = true;
    this.emit("exit", code, signal);
  }

  /** Host messages of one type, in order. */
  of(type) {
    return this.received.filter((m) => m.type === type);
  }
}

/**
 * @param {{ capabilities?: string[], apiVersion?: number, autoReady?: boolean, onMessage?: (msg: any, child: FakeChild) => void }} [opts]
 *   autoReady: answer the host's hello with `ready` (default true). onMessage runs for every message the host writes.
 */
export function fakeSpawn({ capabilities = ["quotes"], apiVersion = 1, autoReady = true, onMessage } = {}) {
  const children = [];
  const calls = [];
  const spawnImpl = (cmd, args, options) => {
    calls.push({ cmd, args, options });
    const child = new FakeChild();
    child.onMessage = (msg, c) => {
      if (msg.type === "hello" && autoReady) c.say({ type: "ready", apiVersion, capabilities });
      onMessage?.(msg, c);
    };
    children.push(child);
    return child;
  };
  return { spawnImpl, children, calls, last: () => children.at(-1) };
}

/** A quote answer that passes validation. `at` is epoch ms. */
export const goodQuotes = (at, symbol = "NSE:RELIANCE") => ({ items: [{ symbol, fields: { ltp: 100.5, close: 99 }, at }] });

/** A manifest that parses, for tests that build hosts directly. */
export function testManifest(overrides = {}) {
  const base = {
    id: "fake-plugin",
    name: "Fake plugin",
    version: "1.0.0",
    apiVersion: 1,
    entry: "index.mjs",
    capabilities: ["quotes"],
    class: "delayed",
    delaySec: 900,
    network: { allowHosts: ["api.vendor-example.com"] },
    limits: { perSecond: 5, perMinute: 100, callTimeoutMs: 200 },
    terms: { url: "https://vendor-example.com/terms", note: "Vendor terms apply." },
  };
  return { ...base, ...overrides, limits: { ...base.limits, ...(overrides.limits ?? {}) } };
}
