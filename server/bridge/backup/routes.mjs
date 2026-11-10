/**
 * Backup routes (docs/openapi.yaml, tag Backup). { data, meta }. Both need the admin scope and this computer.
 *
 *   GET  /v1/backup   the last backup, the schedule and the copies kept in the data folder's backups/ folder
 *   POST /v1/backup   make a backup now and answer with where the file is on this computer
 *
 * The archive itself is never served over HTTP: it holds the keys store and the audit log. The answer carries a path,
 * and the person copies the file from that path.
 */
import { z } from "zod";
import { cliCommand } from "../core/cliName.mjs";
import { BridgeError, NotImplementedError, fromValidation } from "../core/errors.mjs";

const createBody = z.object({ includeSecrets: z.boolean().optional(), includeData: z.boolean().optional() }).strict();
const fileName = (p) => p.split(/[\\/]/).pop();

/** @param {{ deps: any, manager: ReturnType<typeof import("./manager.mjs").createBackupManager> }} o */
export function createBackupRoutes({ deps, manager }) {
  const meta = (ctx) => ({ requestId: ctx.requestId });
  const audit = async (ctx, type, data) => {
    try {
      await deps.audit.append({ type, actor: { kind: ctx.principal.kind, id: ctx.principal.id }, source: ctx.source, requestId: ctx.requestId, data });
    } catch (err) {
      if (!(err instanceof NotImplementedError)) ctx.log.error("audit append failed for a backup", { type, err });
    }
  };
  return {
    getBackup(ctx) {
      return {
        data: {
          ...manager.summary(),
          folder: manager.folder,
          items: manager.list().map((f) => ({ name: f.name, path: f.path, bytes: f.bytes, at: f.at, kind: f.kind })),
          restoreCommand: `${cliCommand()} restore <file>`,
        },
        meta: meta(ctx),
      };
    },
    async createBackup(ctx) {
      const parsed = createBody.safeParse(ctx.body ?? {});
      if (!parsed.success) throw fromValidation(parsed.error);
      let res;
      try {
        res = await manager.run({ kind: "manual", includeSecrets: parsed.data.includeSecrets === true, ...(parsed.data.includeData === undefined ? {} : { includeData: parsed.data.includeData }) });
      } catch (err) {
        if (err instanceof BridgeError) throw err;
        throw new BridgeError("INTERNAL", `The backup could not be written: ${String(err?.message ?? err)}`);
      }
      await audit(ctx, "backup.created", { name: fileName(res.path), bytes: res.bytes, files: res.files, includesSecrets: res.includesSecrets, kind: "manual" });
      return {
        data: {
          path: res.path,
          name: fileName(res.path),
          bytes: res.bytes,
          files: res.files,
          createdAt: res.at,
          kind: "manual",
          includesSecrets: res.includesSecrets,
          includesData: res.includesData === true,
          masterKeyIncluded: false,
          restoreCommand: `${cliCommand()} restore "${res.path}"`,
        },
        meta: meta(ctx),
      };
    },
  };
}
