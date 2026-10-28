import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBrokerRegistry } from "../../brokers/registry.mjs";
import { createApp } from "../core/app.mjs";
import { loadConfig } from "../core/config.mjs";
import { createNullLogger } from "../core/logger.mjs";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "brokers");
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe("broker logos", () => {
  it("every supported broker has a small PNG logo", () => {
    const files = new Set(readdirSync(DIR).filter((f) => f.endsWith(".png")));
    for (const id of createBrokerRegistry().list()) {
      expect(files.has(`${id}.png`), `${id}.png`).toBe(true);
      const buf = readFileSync(join(DIR, `${id}.png`));
      expect(buf.subarray(0, 8).equals(PNG), `${id}.png is a PNG`).toBe(true);
      expect(buf.readUInt32BE(16)).toBe(64); // width
      expect(buf.readUInt32BE(20)).toBe(64); // height
      expect(buf.length).toBeLessThan(16_000);
    }
  });

  describe("served by the Bridge", () => {
    let app;
    let base;
    beforeAll(async () => {
      const { config } = loadConfig({ raw: { server: { port: 0 }, dataDir: mkdtempSync(join(tmpdir(), "mcb-logos-")) }, env: {} });
      app = await createApp({ config, logger: createNullLogger() });
      base = `http://127.0.0.1:${(await app.listen()).port}`;
    });
    afterAll(() => app?.close());

    it("as /dashboard/broker-<id>.png, a PNG under the dashboard's CSP", async () => {
      const r = await fetch(`${base}/dashboard/broker-dhan.png`);
      expect(r.status).toBe(200);
      expect(r.headers.get("content-type")).toBe("image/png");
      expect(r.headers.get("content-security-policy")).toContain("default-src 'none'");
      expect(Buffer.from(await r.arrayBuffer()).subarray(0, 8).equals(PNG)).toBe(true);
    });

    it("the dashboard's three typefaces as font/woff2, and the CSP allows only its own fonts", async () => {
      for (const name of ["font-inter-var-v3.woff2", "font-plus-jakarta-sans-var.woff2", "font-dm-serif-display-italic.woff2"]) {
        const r = await fetch(`${base}/dashboard/${name}`);
        expect(r.status, name).toBe(200);
        expect(r.headers.get("content-type")).toBe("font/woff2");
        expect(Buffer.from(await r.arrayBuffer()).subarray(0, 4).toString("latin1")).toBe("wOF2");
      }
      const csp = (await fetch(`${base}/dashboard`)).headers.get("content-security-policy");
      expect(csp).toContain("font-src 'self'");
      expect(csp).toContain("script-src 'self';");
      expect(csp).not.toMatch(/unsafe-inline|https?:/);
      for (const name of ["font-inter.woff2", "fonts%2Finter-var-v3.woff2", "font-..%2Fapp.js", "OFL-Inter.txt", "font-inter-var-v3.woff2.map"]) {
        expect((await fetch(`${base}/dashboard/${name}`)).status, name).toBe(404);
      }
    });

    it("only for known ids: nothing else in the folder or outside it", async () => {
      for (const name of ["broker-nosuchbroker.png", "broker-README.md", "broker-..%2Fapp.png", "broker-dhan.png.map", "brokers%2Fdhan.png", "broker-DHAN.png"]) {
        expect((await fetch(`${base}/dashboard/${name}`)).status, name).toBe(404);
      }
    });
  });
});
