/**
 * The data routes of the fake Bridge (Node): downloads, datasets, recordings and rules, collections, subscriptions, the event
 * stream and long-range history. The shapes follow the wave plan (docs/openapi.yaml for what exists; the rest are the natural
 * shapes the SDKs assume) and mirror sdk/python/tests/fake_data.py. Tests steer it through `fake.data`:
 *   jobPolls (polls before a job is done), jobFail (reason: the job fails), tamper (file name -> Buffer served instead of the
 *   real one), events (the event log), sseDropAfter (close each event connection after N events), sseFailFirst (answer the
 *   first N event connections with 503), historySeries (symbol -> candles), historyMaxDays (a window longer than this comes
 *   back partial), localRange ([from, to] epoch seconds the Bridge "already stored"), atmDelayed.
 */
import { createHash } from "node:crypto";

export const DAY = 86_400;
const sha = (b) => createHash("sha256").update(b).digest("hex");

export function bars(start, n, step = 300, base = 100) {
  return Array.from({ length: n }, (_, i) => ({ time: start + i * step, open: base + i, high: base + i + 1, low: base + i - 1, close: base + i + 0.5, volume: 100 + i }));
}

export function createDataRoutes(problem) {
  const d = {};
  const pr = (status, code, detail) => problem(status, code, detail);
  const ok = (data, status = 200, meta = {}) => ({ status, body: { data, meta: { requestId: "req_fake", ...meta } } });
  const csvOf = (rows) => ["time,open,high,low,close,volume", ...rows.map((r) => [r.time, r.open, r.high, r.low, r.close, r.volume].join(","))].join("\n") + "\n";

  d.reset = () => {
    Object.assign(d, {
      jobs: new Map(), jobFiles: new Map(), jobGets: new Map(), datasets: new Map(), recordings: new Map(), rules: new Map(), collections: new Map(), subs: new Map(),
      events: [], eventsOldest: 1, dead: new Map(), seq: 0, jobPolls: 2, jobFail: null, tamper: new Map(), sseDropAfter: null, sseFailFirst: 0, historySeries: new Map(), historyMaxDays: null, localRange: null,
      historyLog: [], atmDelayed: false,
      dlSettings: { maxBudgetShare: 0.3, afterHoursOnly: false }, recSettings: { maxBudgetShare: 0.3 }, autoOn: false,
      savedCalls: { day: "2026-11-09", total: 120, byReason: { "dataset-incremental": 100, "local-history": 20 } },
      savedScheduler: { servedFromStream: 5, servedFromCache: 3, coalesced: 2, batched: 0 },
    });
  };
  d.reset();

  const nextId = (p) => `${p}_${String((d.seq += 1)).padStart(4, "0")}`;
  d.emit = (topic, data) => {
    const ev = { id: String(d.events.length + 1), topic, time: "2026-11-09T04:30:00.000Z", apiVersion: "v1", data };
    d.events.push(ev);
    return ev;
  };

  function resolveSymbols(name) {
    const c = d.collections.get(name);
    if (c.kind === "option-universe") {
      const u = c.universe;
      const atm = 26000;
      const n = u.strikes?.count ?? 2;
      const syms = u.includeUnderlying ? [`NSE:${u.underlying}`] : [];
      for (let k = atm - 50 * n; k <= atm + 50 * n; k += 50) for (const side of u.sides ?? ["CE", "PE"]) syms.push(`NFO:${u.underlying}-2026-11-12-${k}-${side}`);
      return [syms, { rule: `current-weekly 2026-11-12, ATM ${atm} +/- ${n}`, atm }];
    }
    return [[...c.symbols], {}];
  }

  const fileRow = (name, content) => ({ name, symbol: name.slice(0, name.lastIndexOf("_")).replace("-", ":"), interval: name.slice(name.lastIndexOf("_") + 1).split(".")[0], rows: 3, bytes: content.length,
    firstBar: "2025-10-09T14:23:20+05:30", lastBar: "2025-10-09T14:33:20+05:30", sha256: sha(content) });

  function makeFiles(req) {
    const files = new Map();
    const syms = req.symbols ?? resolveSymbols(req.collection)[0];
    for (const s of syms) {
      for (const iv of req.intervals) {
        const rows = bars(1_760_000_000, 3);
        const text = req.format === "jsonl" ? rows.map((r) => `${JSON.stringify({ ...r, symbol: s })}\n`).join("") : csvOf(rows);
        files.set(`${s.replace(":", "-")}_${iv}.${req.format === "jsonl" ? "jsonl" : "csv"}`, Buffer.from(text));
      }
    }
    return files;
  }

  function finish(job) {
    job.status = "done";
    job.finishedAt = "2026-11-09T10:05:00+05:30";
    const files = makeFiles(job.request);
    d.jobFiles.set(job.id, files);
    const ds = job.request.dataset;
    if (ds) {
      const cur = d.datasets.get(ds) ?? { name: ds, tags: [], title: null, dataClass: job.dataClass, source: job.source, official: job.official, delaySec: job.delaySec, files: [], updates: 0 };
      d.datasets.set(ds, cur);
      cur.updates += 1;
      const merged = new Map(cur.files.map((f) => [f.name, f]));
      for (const [n, c] of files) merged.set(n, fileRow(n, c));
      cur.files = [...merged.values()];
      Object.assign(cur, { updatedAt: "2026-11-09T10:05:00+05:30" }); // the real Bridge keeps the first and last bar per file (fileRow), not on the dataset
    }
    d.emit("download.done", { id: job.id });
  }

  function jobView(job) {
    const n = d.jobGets.get(job.id) ?? 0;
    if (job.status === "queued" || job.status === "running") {
      if (d.jobFail && n >= 1) {
        job.status = "failed";
        job.reason = d.jobFail;
        job.failure = { code: "SESSION_EXPIRED", message: d.jobFail, fix: "Log in to your broker again on the Accounts page, then resume the job.", symbol: job.items?.[0]?.symbol, interval: job.items?.[0]?.interval, failedItems: job.items?.length ?? 1 };
        d.emit("download.failed", { id: job.id, reason: d.jobFail });
      } else if (n >= d.jobPolls) finish(job);
      else if (n >= 1) job.status = "running";
      d.jobGets.set(job.id, n + 1);
    }
    const total = job.items.length;
    const done = job.status === "done" ? total : job.status === "running" ? 1 : 0;
    const out = { ...job };
    out.progress = { total, done, failed: job.status === "failed" ? total : 0, rows: 3 * done, bytes: 90 * done, etaSec: done === total ? null : 5, current: job.status === "running" ? { symbol: job.items[0].symbol, interval: job.items[0].interval } : null };
    out.items = job.items.map((i) => ({ ...i, status: job.status === "done" ? "done" : i.status, rows: job.status === "done" ? 3 : 0 }));
    if (job.status === "done") out.files = [...d.jobFiles.get(job.id)].map(([nm, c]) => fileRow(nm, c));
    return out;
  }

  const newJob = (req, extra = {}) => {
    const id = nextId("dl");
    const syms = req.symbols ?? resolveSymbols(req.collection)[0];
    const delayed = Boolean(req.backup);
    const job = { id, name: req.name ?? id, status: "queued", request: req, tags: req.tags ?? [], dataClass: delayed ? "delayed" : "realtime", source: delayed ? "yahoo" : "paper", official: !delayed, delaySec: delayed ? 900 : 0,
      createdAt: "2026-11-09T10:00:00+05:30", startedAt: null, finishedAt: null, manifestUrl: `/v1/downloads/${id}/files`, items: syms.flatMap((s) => req.intervals.map((iv) => ({ symbol: s, interval: iv, status: "queued" }))), notes: [], ...extra };
    d.jobs.set(id, job);
    return job;
  };
  const queuedView = (job) => ({ ...job, progress: { total: job.items.length, done: 0, failed: 0, rows: 0, bytes: 0, etaSec: null, current: null } });

  // The settings routes, in the real shapes: the values in force, the config defaults, the allowed range.
  const settingsView = (current) => ({ ...current, defaults: { maxBudgetShare: 0.3 }, limits: { minBudgetShare: 0.05, maxBudgetShare: 0.8 }, changed: [] });
  function settingsRoute(method, current, body, allowed) {
    if (method === "GET") return ok(settingsView(current));
    const keys = Object.keys(body ?? {});
    if (!keys.length || keys.some((k) => !allowed.includes(k))) return pr(400, "VALIDATION_FAILED", `Send ${allowed.join(" and/or ")}.`);
    const share = body.maxBudgetShare;
    if (share !== undefined && !(typeof share === "number" && share >= 0.05 && share <= 0.8)) return pr(400, "VALIDATION_FAILED", "maxBudgetShare must be from 0.05 to 0.8.");
    Object.assign(current, body);
    return ok(settingsView(current));
  }
  function estimate(req, syms, q) {
    const rows = syms.length * req.intervals.length * 3 * 75;
    const stored = d.datasets.has(req.dataset) ? 40 : 0;
    const calls = Math.max(0, syms.length * req.intervals.length - stored);
    return ok({ symbols: syms.length, intervals: req.intervals.length, items: syms.length * req.intervals.length, brokerCalls: calls, callsSaved: stored, rows, rowsToFetch: rows, bytes: rows * 62, bytesPerRow: 62,
      etaSec: calls * 4, budgetShare: d.dlSettings.maxBudgetShare, account: "paper", alreadyStored: false, disk: { usedBytes: 0, maxBytes: 5000 * 1024 * 1024, wouldExceed: false }, notes: ["Rows assume every trading minute has a bar."] }, 200, { dryRun: true });
  }

  function downloads(method, parts, q, body) {
    if (parts.length === 1 && parts[0] === "settings") return settingsRoute(method, d.dlSettings, body, ["maxBudgetShare", "afterHoursOnly"]);
    if (!parts.length) {
      if (method === "POST") {
        const req = { ...body };
        const syms = req.symbols ?? (d.collections.has(req.collection) ? resolveSymbols(req.collection)[0] : null);
        if (!syms || !req.intervals) return pr(400, "VALIDATION_FAILED", "symbols (or collection) and intervals are required");
        if (syms.length > 500) return pr(400, "VALIDATION_FAILED", "at most 500 symbols");
        if (q.dryRun === "1" || q.dryRun === "true") return estimate(req, syms, q);
        return ok(queuedView(newJob(req)), 202);
      }
      return ok([...d.jobs.values()].reverse().filter((j) => !q.status || j.status === q.status).map(jobView), 200, { nextCursor: null });
    }
    const job = d.jobs.get(parts[0]);
    if (!job) return pr(404, "NOT_FOUND", `No download ${parts[0]}.`);
    const rest = parts.slice(1);
    if (!rest.length) {
      if (method === "GET") return ok(jobView(job));
      if (method === "DELETE") {
        d.jobs.delete(job.id);
        d.jobFiles.delete(job.id);
        return ok({ deleted: job.id });
      }
      if (method === "PATCH") {
        for (const k of ["name", "tags"]) if (k in (body ?? {})) job[k] = body[k];
        return ok(jobView(job));
      }
    }
    if (method === "POST" && ["pause", "resume", "cancel"].includes(rest[0]) && rest.length === 1) {
      job.status = { pause: "paused", resume: "running", cancel: "cancelled" }[rest[0]];
      return ok(jobView(job));
    }
    if (method === "GET" && rest[0] === "files" && rest.length === 1) return ok(job.status === "done" ? [...d.jobFiles.get(job.id)].map(([n, c]) => fileRow(n, c)) : []);
    if (method === "GET" && rest[0] === "files" && rest.length === 2) {
      const c = d.jobFiles.get(job.id)?.get(rest[1]);
      if (!c) return pr(404, "NOT_FOUND", "No such file.");
      return { status: 200, body: d.tamper.get(rest[1]) ?? c, headers: { "Content-Type": "text/csv; charset=utf-8" } };
    }
    return pr(404, "NOT_FOUND", "No such route.");
  }

  function datasets(method, parts, q, body) {
    if (!parts.length) return ok([...d.datasets.values()].filter((x) => !q.tag || x.tags.includes(q.tag)), 200, { nextCursor: null });
    const ds = d.datasets.get(parts[0]);
    if (!ds) return pr(404, "NOT_FOUND", `No dataset ${parts[0]}.`);
    if (method === "GET" && parts.length === 1) return ok(ds);
    if (method === "PATCH" && parts.length === 1) {
      if ("tags" in (body ?? {})) ds.tags = body.tags;
      if ("title" in (body ?? {})) ds.title = body.title;
      const unknown = Object.keys(body ?? {}).filter((k) => !["name", "tags", "title"].includes(k));
      if (unknown.length) return pr(400, "VALIDATION_FAILED", `Unrecognized key: "${unknown[0]}"`);
      if (body?.name) {
        d.datasets.delete(ds.name);
        ds.name = body.name;
        d.datasets.set(ds.name, ds);
      }
      return ok(ds);
    }
    if (method === "POST" && parts[1] === "update") {
      const req = { symbols: [...new Set(ds.files.map((f) => f.symbol))].sort(), intervals: [...new Set(ds.files.map((f) => f.interval))].sort(), dataset: ds.name, from: ds.files.map((f) => f.lastBar).sort().at(-1) };
      return ok(queuedView(newJob(req, { name: `update ${ds.name}`, dataClass: ds.dataClass, source: ds.source, official: ds.official, delaySec: ds.delaySec })), 202);
    }
    return pr(404, "NOT_FOUND", "No such route.");
  }

  const recBytes = (rec) => Buffer.from(`time,symbol,ltp\n2026-11-09T09:15:00+05:30,${rec.symbols[0] ?? "NSE:X"},100.5\n2026-11-09T09:15:30+05:30,${rec.symbols[0] ?? "NSE:X"},100.75\n`);
  const recFile = (rec) => { const b = recBytes(rec); return { name: `${rec.id}_2026-11-09.csv`, day: "2026-11-09", rows: 2, bytes: b.length, sha256: sha(b) }; };

  function rules(method, parts, body) {
    if (!parts.length) {
      if (method === "POST") {
        if (!body?.name || !body?.kind) return pr(400, "VALIDATION_FAILED", "name and kind are required");
        const id = nextId("rule");
        const rule = { ...body, id, enabled: body.enabled ?? true };
        d.rules.set(id, rule);
        return ok(rule, 201);
      }
      return ok([...d.rules.values()]);
    }
    const rule = d.rules.get(parts[0]);
    if (!rule) return pr(404, "NOT_FOUND", `No rule ${parts[0]}.`);
    if (method === "PATCH") return ok(Object.assign(rule, body));
    if (method === "DELETE") {
      d.rules.delete(parts[0]);
      return ok({ deleted: parts[0] });
    }
    return ok(rule);
  }

  const PRESETS = [
    { id: "index-option-chains", title: "Record index option chains", about: "NIFTY and BANKNIFTY option chains.", needs: "a connected broker login", rule: { name: "Index option chains", kind: "chain", underlying: ["NIFTY", "BANKNIFTY"], everySec: 30, schedule: "market-hours", format: "csv" } },
    { id: "my-watchlist", title: "Record my watchlist", about: "Every symbol of your watchlist.", needs: "a collection called watchlist", rule: { name: "My watchlist", kind: "quotes", collection: "watchlist", everySec: 1, schedule: "market-hours", format: "csv" } },
  ];
  function recordingExtras(method, parts, body) {
    if (parts[0] === "settings") return settingsRoute(method, d.recSettings, body, ["maxBudgetShare"]);
    if (parts[0] === "status" && method === "GET") {
      const running = [...d.recordings.values()].filter((r) => r.status === "running");
      const rows = [...d.recordings.values()].reduce((n, r) => n + r.rows, 0);
      return ok({ line: running.length ? `Recording today: ${running.length} recordings, ${rows} rows.` : "Recording is off. Nothing is being saved.", enabled: true,
        auto: { enabled: d.autoOn, rules: d.rules.size, activeRules: d.autoOn ? d.rules.size : 0 },
        today: { date: "2026-11-09", recordings: running.length, symbols: 0, rows, bytes: rows * 40, lastWriteAt: null, gaps: 0, openGaps: 0 }, disk: { usedBytes: rows * 40, limitMb: 5000 },
        apiCalls: { made: 0, saved: 7 }, budgetShare: d.recSettings.maxBudgetShare, dataClass: "realtime" });
    }
    if (parts[0] === "presets" && parts.length === 1 && method === "GET") return ok(PRESETS);
    if (parts[0] === "presets" && parts[2] === "apply" && method === "POST") {
      const preset = PRESETS.find((p) => p.id === parts[1]);
      if (!preset) return pr(404, "NOT_FOUND", `No preset named ${parts[1]}.`);
      const existing = [...d.rules.values()].find((r) => r.preset === preset.id);
      const rule = existing ?? { ...preset.rule, id: nextId("rule"), enabled: true, preset: preset.id, ...(preset.id === "my-watchlist" && body?.collection ? { collection: body.collection } : {}) };
      d.rules.set(rule.id, rule);
      d.autoOn = true;
      return ok({ preset: preset.id, created: !existing, rule, auto: { enabled: true, rules: d.rules.size, activeRules: d.rules.size } }, existing ? 200 : 201);
    }
    return null;
  }

  function recordings(method, parts, q, body) {
    if (parts[0] === "rules") return rules(method, parts.slice(1), body);
    const extra = recordingExtras(method, parts, body);
    if (extra) return extra;
    if (!parts.length) {
      if (method === "POST") {
        if ((body.everySec ?? 0) < (body.kind === "chain" ? 15 : 1)) return pr(400, "VALIDATION_FAILED", "everySec is too small");
        const id = nextId("rec");
        const rec = { id, name: body.name ?? id, kind: body.kind, status: "running", symbols: body.symbols ?? [], underlying: body.underlying, expiry: body.expiry, everySec: body.everySec, sessionOnly: body.sessionOnly ?? true,
          format: body.format ?? "csv", rows: 0, bytes: 0, lastWriteAt: null, gaps: [], diskBytes: 0, dataClass: "realtime", source: "stream", collection: body.collection, files: [] };
        d.recordings.set(id, rec);
        d.emit("recording.started", { id });
        return ok(rec, 201);
      }
      return ok([...d.recordings.values()].filter((r) => !q.status || r.status === q.status));
    }
    const rec = d.recordings.get(parts[0]);
    if (!rec) return pr(404, "NOT_FOUND", `No recording ${parts[0]}.`);
    const rest = parts.slice(1);
    if (!rest.length && method === "GET") return ok(rec);
    if (!rest.length && method === "DELETE") {
      d.recordings.delete(rec.id);
      return ok({ deleted: rec.id });
    }
    if (method === "POST" && ["pause", "resume", "stop"].includes(rest[0])) {
      rec.status = { pause: "paused", resume: "running", stop: "stopped" }[rest[0]];
      if (rest[0] === "stop") d.emit("recording.stopped", { id: rec.id });
      return ok(rec);
    }
    if (method === "GET" && rest[0] === "files" && rest.length === 1) return ok([recFile(rec)]);
    if (method === "GET" && rest[0] === "files" && rest.length === 2) return { status: 200, body: recBytes(rec), headers: { "Content-Type": "text/csv" } };
    return pr(404, "NOT_FOUND", "No such route.");
  }

  function collections(method, parts, q, body) {
    if (!parts.length) {
      if (method === "POST") {
        if (!body?.name) return pr(400, "VALIDATION_FAILED", "name is required");
        if (d.collections.has(body.name)) return pr(409, "STATE_CONFLICT", `A collection called ${body.name} exists.`);
        const c = { id: nextId("col"), name: body.name, description: body.description ?? null, tags: body.tags ?? [], kind: body.kind ?? "static", symbols: body.symbols ?? [], universe: body.universe ?? null, updatedAt: "2026-11-09T10:00:00+05:30" };
        d.collections.set(c.name, c);
        return ok(c, 201);
      }
      return ok([...d.collections.values()].filter((c) => (!q.tag || c.tags.includes(q.tag)) && (!q.kind || c.kind === q.kind)));
    }
    const name = parts[0];
    const c = d.collections.get(name);
    if (!c) return pr(404, "NOT_FOUND", `No collection ${name}.`);
    const rest = parts.slice(1);
    if (!rest.length && method === "GET") return ok(c);
    if (!rest.length && method === "PATCH") {
      const { name: newName, ...ch } = body ?? {};
      Object.assign(c, ch);
      if (newName) {
        d.collections.delete(name);
        c.name = newName;
        d.collections.set(newName, c);
      }
      return ok(c);
    }
    if (!rest.length && method === "DELETE") {
      d.collections.delete(name);
      return ok({ deleted: name });
    }
    if (rest[0] === "resolve") {
      const [symbols, info] = resolveSymbols(name);
      const out = { name, symbols, resolvedAt: "2026-11-09T10:00:00+05:30", ...info };
      if (c.kind === "option-universe") out.atmSource = "stream";
      if (c.kind === "option-universe" && d.atmDelayed === "delayed") return pr(422, "VALIDATION_FAILED", "The underlying price is delayed: an ATM from it would be wrong.");
      if (c.kind === "option-universe" && d.atmDelayed === "stale") {
        if (q.allowStale !== "1") return pr(503, "UPSTREAM_ERROR", "The underlying price is stale.");
        out.warnings = ["The underlying price is stale (45 s old); ATM may have moved."];
        out.atmSource = "cache";
        out.freshness = { source: "cache", class: "realtime", delaySec: 0, official: true, stale: true, ageMs: 45_000 };
      }
      return ok(out);
    }
    if (rest[0] === "usage") return ok({ downloads: [...d.jobs.values()].filter((j) => j.request.collection === name).map((j) => j.id), recordings: [], datasets: [] });
    if (rest[0] === "estimate") {
      const [symbols] = resolveSymbols(name);
      const days = Number(q.days ?? 1);
      const n = symbols.length * (q.intervals ?? "5m").split(",").length * days;
      return ok({ symbols: symbols.length, rows: n * 75, bytes: n * 75 * 40, brokerCalls: Math.floor(n / 30) + 1 });
    }
    return pr(404, "NOT_FOUND", "No such route.");
  }

  function subs(method, parts, q, body) {
    if (!parts.length) {
      if (method === "POST") {
        const id = nextId("sub");
        const s = { id, url: body.url, topics: body.topics, active: body.active ?? true, label: body.label ?? null, host: "example.org", state: "unverified" };
        d.subs.set(id, { ...s, secret: body.secret });
        return ok(s, 201);
      }
      return ok([...d.subs.values()].map(({ secret, ...s }) => s));
    }
    const s = d.subs.get(parts[0]);
    if (!s) return pr(404, "NOT_FOUND", "No subscription.");
    if (method === "PATCH" && parts.length === 1) {
      Object.assign(s, body);
      const { secret, ...pub } = s;
      return ok(pub);
    }
    if (method === "DELETE" && parts.length === 1) {
      d.subs.delete(parts[0]);
      return ok({ deleted: parts[0] });
    }
    if (method === "GET" && parts.length === 1) {
      const { secret, ...pub } = s;
      return ok(pub);
    }
    if (method === "POST" && parts[1] === "test") return ok({ delivered: true, status: 200 });
    if (method === "GET" && parts[1] === "deliveries") {
      const rows = [{ id: "d1", outcome: "delivered", attempts: 1, status: 200 }, { id: "d2", outcome: "dead", attempts: 8, status: 503 }];
      return ok(rows.filter((r) => !q.outcome || r.outcome === q.outcome));
    }
    if (parts[1] === "dead-letters") {
      if (!d.dead.has(parts[0])) d.dead.set(parts[0], [{ id: "del_1", eventId: "7", topic: "download.done", reason: "http_5xx" }, { id: "del_2", eventId: "8", topic: "download.failed", reason: "timeout" }]);
      const dead = d.dead.get(parts[0]);
      if (method === "GET" && parts.length === 2) return ok([...dead]);
      if (method === "DELETE" && parts.length === 2) {
        const n = dead.length;
        dead.length = 0;
        return ok({ removed: n });
      }
      if (method === "POST" && parts.length === 4 && parts[3] === "retry") {
        const i = dead.findIndex((x) => x.id === parts[2]);
        if (i < 0) return pr(404, "NOT_FOUND", "No such dead letter.");
        dead.splice(i, 1);
        return ok({ id: parts[2], queued: true }, 202);
      }
    }
    return pr(404, "NOT_FOUND", "No such route.");
  }

  function eventStream(q, headers) {
    if (d.sseFailFirst > 0) {
      d.sseFailFirst -= 1;
      return pr(503, "BROKER_UNAVAILABLE", "events are starting up");
    }
    const since = q.since ?? headers["last-event-id"];
    const topics = (q.topics ?? "").split(",").filter(Boolean);
    const latest = d.events.length;
    let gap = false;
    let gapReason = null;
    if (since !== undefined && Number(since) > latest) [gap, gapReason] = [true, "cursor_ahead"];
    if (since !== undefined && d.eventsOldest > 1 && Number(since) < d.eventsOldest - 1) [gap, gapReason] = [true, "retention"];
    const frames = [`event: ready\ndata: ${JSON.stringify({ cursor: String(latest), oldest: String(d.eventsOldest), replayed: 0, gap, gapReason, topics: topics.length ? topics : ["*"] })}\n\n`];
    let sent = 0;
    for (const ev of d.events) {
      if (since !== undefined && Number(ev.id) <= Number(since)) continue;
      if (topics.length && !topics.some((t) => t === "*" || t === ev.topic || (t.endsWith(".*") && ev.topic.startsWith(t.slice(0, -1))))) continue;
      frames.push(`id: ${ev.id}\nevent: ${ev.topic}\ndata: ${JSON.stringify(ev)}\n\n`);
      sent += 1;
      if (d.sseDropAfter !== null && sent >= d.sseDropAfter) break;
      frames.push(": heartbeat\n\n");
    }
    return { status: 200, frames };
  }

  function eventsPoll(q) {
    const topics = (q.topics ?? "").split(",").filter(Boolean);
    let rows = d.events.filter((e) => (q.since === undefined || Number(e.id) > Number(q.since)) && (!topics.length || topics.some((t) => t === "*" || t === e.topic || (t.endsWith(".*") && e.topic.startsWith(t.slice(0, -1))))));
    rows = rows.slice(0, Number(q.limit ?? 100));
    const gap = q.since !== undefined && Number(q.since) > d.events.length;
    return ok(rows, 200, { cursor: rows.at(-1)?.id ?? q.since ?? String(d.events.length), latest: String(d.events.length), gap, gapReason: gap ? "cursor_ahead" : null, hasMore: false });
  }

  function history(q) {
    const a = Math.floor(Number(q.from));
    const b = Math.floor(Number(q.to));
    d.historyLog.push({ from: a, to: b, localFirst: q.localFirst, dataset: q.dataset });
    let series = d.historySeries.get(q.symbol).filter((c) => c.time >= a && c.time <= b);
    let partial = false;
    if (d.historyMaxDays !== null && b - a > d.historyMaxDays * DAY) {
      const keep = b - Math.floor(d.historyMaxDays * DAY);
      series = series.filter((c) => c.time >= keep);
      partial = true;
    }
    let source = "broker";
    let fr = { source: "broker", asOf: "2026-11-09T10:00:00.000+05:30", ageMs: 12, stale: false, class: "realtime", delaySec: 0, official: true, confidence: "high", flags: [] };
    if (q.localFirst === "true" && d.localRange) {
      const [l0, l1] = d.localRange;
      if (a >= l0 && b <= l1) source = "local";
      else if (b >= l0 && a <= l1) source = "mixed";
      if (source !== "broker") fr = { ...fr, source: "local" };
    }
    if (q.backup === "true") fr = { ...fr, source: "backup", class: "delayed", delaySec: 900, official: false, confidence: "low" };
    return ok({ symbol: q.symbol, interval: q.interval, candles: series, freshness: fr, partial }, 200, { source });
  }

  d.route = (method, path, q, body, headers) => {
    if (!path.startsWith("/v1/")) return null;
    const parts = path.split("/").slice(2).map(decodeURIComponent);
    if (path === "/v1/limits" && method === "GET") {
      const data = { safety: {}, brokers: {}, client: { perSecond: 10, burst: 20, remaining: 20 }, accounts: [] };
      if (q.explain === "1" || q.explain === "true") {
        data.pools = [];
        data.consumers = [];
        data.savedCalls = { ...d.savedCalls, scheduler: { ...d.savedScheduler }, totalToday: d.savedCalls.total + Object.values(d.savedScheduler).reduce((a, n) => a + n, 0) };
      }
      return ok(data);
    }
    switch (parts[0]) {
      case "downloads": return downloads(method, parts.slice(1), q, body);
      case "datasets": return datasets(method, parts.slice(1), q, body);
      case "recordings": return recordings(method, parts.slice(1), q, body);
      case "collections": return collections(method, parts.slice(1), q, body);
      case "subscriptions": return subs(method, parts.slice(1), q, body);
      case "events":
        if (method !== "GET") return null;
        if (parts[1] === "stream") return eventStream(q, headers);
        if (parts[1] === "topics") return ok([{ topic: "download.done", scope: "read", accountScoped: false, description: "A data download finished" }]);
        if (parts.length === 1) return eventsPoll(q);
        return null;
      case "instruments":
        return parts[1] === "export" && method === "GET" ? { status: 200, body: Buffer.from("symbol,exchange,kind\nNSE:RELIANCE,NSE,EQ\nNSE:TCS,NSE,EQ\n"), headers: { "Content-Type": "text/csv" } } : null;
      case "history": return method === "GET" && d.historySeries.has(q.symbol) ? history(q) : null;
      default: return null;
    }
  };
  return d;
}
