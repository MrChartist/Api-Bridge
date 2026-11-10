/**
 * OPS-08: GET /v1/metrics is admin-only and this computer only, Prometheus text, counters and gauges, and carries no
 * symbol, key or account id.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createApp } from "./app.mjs";
import { loadConfig } from "./config.mjs";
import { createNullLogger } from "./logger.mjs";
import { toPrometheus } from "./metrics.mjs";

describe("toPrometheus", () => {
  it("one HELP and TYPE per name, labels quoted and escaped, non-numbers dropped", () => {
    const text = toPrometheus([
      { name: "a_total", help: "A.", type: "counter", value: 3, labels: { status_class: "2xx" } },
      { name: "a_total", value: 1, labels: { status_class: '4"xx' } },
      { name: "g", value: Number.NaN },
      { name: "h", value: 7 },
    ]);
    expect(text).toBe('# HELP a_total A.\n# TYPE a_total counter\na_total{status_class="2xx"} 3\na_total{status_class="4\\"xx"} 1\n# TYPE h gauge\nh 7\n');
  });
});

describe("GET /v1/metrics", () => {
  it("is Prometheus text with the numbers the audit asked for, behind an admin key, with nothing private in it", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "mcb-metrics-"));
    const { config } = loadConfig({ raw: { dataDir, server: { port: 0 } }, env: {}, demo: true });
    const app = await createApp({ config, logger: createNullLogger() });
    const { port } = await app.listen();
    try {
      const { key: admin } = await app.deps.keyStore.create({ label: "ops", scopes: ["admin", "paper"] });
      const { key: read } = await app.deps.keyStore.create({ label: "reader", scopes: ["read"] });
      const url = `http://127.0.0.1:${port}/v1/metrics`;
      expect((await fetch(url)).status).toBe(401);
      expect((await fetch(url, { headers: { authorization: `Bearer ${read}` } })).status).toBe(403);
      await fetch(`http://127.0.0.1:${port}/v1/nothing`); // a 404 to count
      const res = await fetch(url, { headers: { authorization: `Bearer ${admin}` } });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toMatch(/^text\/plain/);
      const body = await res.text();
      for (const name of ["bridge_uptime_seconds", "process_resident_memory_bytes", "process_open_fds", "nodejs_eventloop_lag_p99_seconds", "bridge_http_requests_total", "bridge_storage_free_bytes", "bridge_storage_write_errors_total", "bridge_quarantined_files", "bridge_webhook_pending", "bridge_sse_clients", "bridge_downloads_running", "bridge_recorder_disk_bytes"]) {
        expect(body, name).toMatch(new RegExp(`^${name}`, "m"));
      }
      expect(body).toMatch(/bridge_http_requests_total\{status_class="4xx"\} [1-9]/);
      expect(body).toMatch(/^# TYPE bridge_http_requests_total counter$/m);
      // no key, account id, symbol or path appears
      expect(body).not.toContain(admin);
      expect(body).not.toContain(read);
      expect(body).not.toMatch(/NSE:|demo-|mcb_/);
      expect(body).not.toContain(dataDir);
      // every line is a comment or "name{labels} number"
      for (const line of body.trim().split("\n")) expect(line).toMatch(/^(# (HELP|TYPE) .+|[a-z0-9_]+(\{[a-z_]+="[^"]*"\})? -?[0-9.e+]+)$/);
    } finally {
      await app.close();
    }
  });
});
