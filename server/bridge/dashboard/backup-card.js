// The Backups card on the Safety page: when the data was last copied, a "Back up now" button, what a backup holds and
// what it never holds, and the command that restores one.
//
// It talks to GET and POST /v1/backup (admin key, this computer only). The archive is never served over HTTP: the
// Bridge answers with the file's path ON THIS COMPUTER, and the person copies the file from there.
//
// The view-model (backupModel, formatBytes, ageText) is pure and exported for backup-card.test.mjs; the DOM code runs
// only in a browser. Words are plain: what happened, what to do next.
import { alertBox, api, codeBlock, h, icon, iconTile, pill, toast } from "./app.js";
import { formatFixed, formatInt, plural } from "./format.js";

const DAY = 86_400_000;

/** "148 KB", "3.2 MB". Pure. */
export function formatBytes(n) {
  if (!Number.isFinite(n) || n < 0) return "";
  if (n < 1024) return `${Math.max(1, Math.round(n))} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 * 1024 * 1024) return `${formatFixed(n / 1048576, 1)} MB`;
  return `${formatFixed(n / 1073741824, 1)} GB`;
}

/** "just now", "5 minutes ago", "3 hours ago", "2 days ago". Pure. */
export function ageText(iso, now = Date.now()) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const ms = Math.max(0, now - t);
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${plural(Math.floor(ms / 60_000), "minute")} ago`;
  if (ms < DAY) return `${plural(Math.floor(ms / 3_600_000), "hour")} ago`;
  return `${plural(Math.floor(ms / DAY), "day")} ago`;
}

/**
 * What the card shows, from GET /v1/backup's `data`. Pure.
 * @returns {{ tone: "ok" | "warn" | "bad", state: string, headline: string, detail: string, failure: string | null,
 *   schedule: string, latestPath: string | null, restoreCommand: string, items: Array<{ name: string, path: string, kind: string, bytes: number, at: string }> }}
 */
export function backupModel(d, now = Date.now()) {
  const sch = d?.schedule ?? { enabled: false };
  const failure = d?.lastError ? `${d.lastError.message}` : null;
  const last = d?.lastBackupAt ? Date.parse(d.lastBackupAt) : null;
  const age = last === null ? null : now - last;
  const stale = age !== null && age >= (sch.enabled ? 3 : 30) * DAY;
  const items = Array.isArray(d?.items) ? d.items : [];
  let tone = "ok";
  let state = "Backed up";
  let headline = `Last backup ${ageText(d?.lastBackupAt, now)}`;
  if (last === null) {
    tone = "warn";
    state = "No backup yet";
    headline = "No backup yet";
  } else if (stale) {
    tone = "warn";
    state = "Out of date";
  }
  if (failure) {
    tone = "bad";
    state = "Last backup failed";
  }
  const parts = [];
  if (last !== null) parts.push(formatBytes(d.lastBackupBytes), d.lastBackupKind ? ({ manual: "made by hand", upgrade: "before an upgrade", scheduled: "daily", safety: "before a restore" }[d.lastBackupKind] ?? d.lastBackupKind) : "");
  const schedule = sch.enabled ? `Daily at ${sch.time}, keeping the newest ${formatInt(sch.keep)}.` : "Daily backup is off. To turn it on, set backup.schedule.enabled to true in bridge.config.json.";
  const latest = items[0]?.path ?? null;
  return {
    tone,
    state,
    headline,
    detail: parts.filter(Boolean).join(" · "),
    failure,
    schedule,
    latestPath: latest,
    restoreCommand: latest ? `${(d?.restoreCommand ?? "mc-bridge restore <file>").replace(/ <file>$/, "")} "${latest}"` : (d?.restoreCommand ?? "mc-bridge restore <file>"),
    items,
  };
}

/** The Safety page's "Backups" section. */
export function backupSection() {
  const body = h("div", { class: "bk-body" }, h("p", { class: "sf-working", role: "status" }, "Reading backups..."));
  const section = h(
    "section",
    { class: "sec bk", "aria-labelledby": "bk-h" },
    h("header", { class: "sec-head" }, h("div", { class: "sec-titles" }, h("h2", { id: "bk-h" }, "Backups"), h("p", {}, "A copy of your API keys, accounts, paper books, order records and audit log, kept on this computer."))),
    body,
  );
  let made = null;

  const draw = (d) => {
    const m = backupModel(d);
    const doneBox = h("div", { class: "bk-done", "aria-live": "polite" });
    if (made) {
      doneBox.append(
        h("div", { class: "alert ok", role: "status" }, icon("check"), h("div", {}, h("strong", {}, "Backup saved"), h("span", { class: "detail" }, `${plural(made.files, "file")}, ${formatBytes(made.bytes)}. The file is on this computer, and only you can read it.`))),
        codeBlock(made.path, { title: "Saved here" }),
        h("p", { class: "bk-note" }, "A backup next to the data does not survive a failed disk. Copy this file to another disk or another computer."),
      );
    }
    const btn = h("button", { type: "button", class: "primary", id: "bk-now" }, icon("download"), "Back up now");
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      btn.setAttribute("aria-busy", "true");
      try {
        made = (await api("/v1/backup", { method: "POST", body: {} })).data.data;
        toast("Backup saved");
        await load();
      } catch (err) {
        btn.disabled = false;
        btn.removeAttribute("aria-busy");
        doneBox.replaceChildren(alertBox(err));
      }
    });
    const statusRow = h(
      "div",
      { class: "list-row static bk-row" },
      iconTile(m.tone === "bad" ? "warn" : "safety", m.tone === "ok" ? "green" : m.tone === "bad" ? "red" : "orange", "md"),
      h("span", { class: "names" }, h("span", { class: "nm" }, m.headline), m.detail ? h("span", { class: "sub" }, m.detail) : null),
      pill(m.state, m.tone),
      btn,
    );
    const scheduleRow = h("div", { class: "list-row static bk-row" }, iconTile("clock", "gray", "md"), h("span", { class: "names" }, h("span", { class: "nm" }, "Daily backup"), h("span", { class: "sub bk-wrap" }, m.schedule)));
    const kept = m.items.length ? h("p", { class: "bk-note" }, `${plural(m.items.length, "copy", "copies")} in ${d.folder}`) : null;
    body.replaceChildren(
      ...[
      m.failure ? alertBox({ title: "The last backup failed", detail: m.failure }) : null,
      h("div", { class: "list" }, statusRow, scheduleRow),
      doneBox,
      h(
        "div",
        { class: "sf-card bk-what" },
        h("h3", {}, "What a backup holds"),
        h("p", {}, "Your settings file, API key records, accounts, safety and quota state, data-source settings, pooling consent, paper books, order records and the audit log."),
        h("h3", {}, "What it never holds"),
        h("p", {}, "Your master key. It is never copied into a backup, so the file alone cannot unlock anything. Saved broker logins (secrets.enc) are left out unless you add them with the command line, and they open only with your original master key."),
      ),
      h("div", { class: "bk-restore" }, h("h3", {}, "To restore"), h("p", { class: "bk-note" }, "Stop the Bridge, then run this in a terminal. It checks the file first and keeps a copy of what is there now."), codeBlock(m.restoreCommand, { title: "Restore" }), kept),
      ].filter(Boolean),
    );
  };

  const load = async () => {
    try {
      draw((await api("/v1/backup", { fresh: true })).data.data);
    } catch (err) {
      // From another computer (a shared demo) or without an admin key, the Bridge refuses: say so, calmly.
      const refused = err?.status === 403 || err?.code === "LOOPBACK_ONLY" || err?.code === "FORBIDDEN";
      body.replaceChildren(
        refused
          ? h("div", { class: "alert info" }, icon("info"), h("div", {}, h("strong", {}, "Backups are made from the computer the Bridge runs on"), h("span", { class: "detail" }, "They need an admin key and a page opened on that computer. In a terminal there, run: mc-bridge backup")))
          : alertBox(err),
      );
    }
  };
  load();
  return section;
}
