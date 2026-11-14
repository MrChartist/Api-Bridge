/**
 * Notification routes (docs/openapi.yaml, tag "Notifications"). Every route needs an admin key; every route that changes
 * something or sends a message is this-computer-only, so a bot token can only ever be typed here. No response carries a
 * token or a chat id: only masked hints and the short chat `key`.
 *
 *   GET    /v1/notify/status                          queue depth, last delivery, last error per target, counters
 *   GET    /v1/notify/targets                         the Telegram bots and their chats (masked)
 *   POST   /v1/notify/targets                         { token, label? }: check the token with Telegram, store it encrypted
 *   DELETE /v1/notify/targets/{targetId}
 *   POST   /v1/notify/targets/{targetId}/test         send a test message, report delivery per chat
 *   POST   /v1/notify/targets/{targetId}/find-chat    chats that wrote to the bot recently
 *   POST   /v1/notify/targets/{targetId}/chats        { ref } or { chatId, name? }, commands?: put a chat on the list
 *   PATCH  /v1/notify/targets/{targetId}/chats/{chatKey}   { commands }
 *   DELETE /v1/notify/targets/{targetId}/chats/{chatKey}
 *   GET    /v1/notify/events                          every event with its plain label and whether it is on
 *   PUT    /v1/notify/events                          { events?, quietHours?, morning? }: change what is sent
 */
import { z } from "zod";
import { BridgeError, fromValidation } from "../core/errors.mjs";
import { json, noContent } from "../core/http.mjs";
import { eventFlagsSchema, morningSchema, quietHoursSchema } from "./config.mjs";
import { isTargetId } from "./targets.mjs";

const targetCreate = z.object({ kind: z.literal("telegram").default("telegram"), token: z.string().min(10).max(120), label: z.string().trim().max(40).optional() }).strict();
const testBody = z.object({ chat: z.string().regex(/^[0-9a-f]{10}$/).optional() }).strict();
const chatAdd = z
  .object({ ref: z.string().regex(/^[0-9a-f]{10}$/).optional(), chatId: z.string().trim().max(40).optional(), name: z.string().trim().max(60).optional(), commands: z.boolean().optional() })
  .strict()
  .refine((b) => Boolean(b.ref) !== Boolean(b.chatId), { message: "send either ref (from Find my chat) or chatId" });
const chatPatch = z.object({ commands: z.boolean() }).strict();
const eventsPut = z
  .object({
    events: eventFlagsSchema.optional(),
    quietHours: quietHoursSchema.partial().optional(),
    morning: morningSchema.partial().extend({ endOfDay: z.object({ enabled: z.boolean().optional(), at: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional() }).strict().optional() }).optional(),
  })
  .strict();

const parse = (schema, value, detail) => {
  const r = schema.safeParse(value ?? {});
  if (!r.success) throw fromValidation(r.error, detail);
  return r.data;
};
const meta = (ctx) => ({ requestId: ctx.requestId });
const NO_STORE = { "Cache-Control": "no-store" };

/** @param {{ notify: any, audit?: any }} deps */
export function createNotifyRoutes(deps) {
  const svc = () => deps.notify;
  const targetId = (ctx) => {
    const id = String(ctx.params.targetId ?? "");
    if (!isTargetId(id)) throw new BridgeError("NOT_FOUND", "No such notification target.");
    return id;
  };
  const chatKey = (ctx) => {
    const k = String(ctx.params.chatKey ?? "");
    if (!/^[0-9a-f]{10}$/.test(k)) throw new BridgeError("NOT_FOUND", "No such chat on this target.");
    return k;
  };
  const audit = async (ctx, type, data) => {
    try {
      await deps.audit?.append?.({ type, actor: { kind: ctx.principal?.kind ?? "anonymous", id: ctx.principal?.id ?? "anonymous" }, source: ctx.source ?? "rest", requestId: ctx.requestId, data });
    } catch {
      /* a missing audit log must not undo a setting; the audit module logs its own failure */
    }
  };

  return {
    async getStatus(ctx) {
      return { data: await svc().status(), meta: meta(ctx) };
    },
    async listTargets(ctx) {
      return { data: await svc().listTargets(), meta: meta(ctx) };
    },
    async createTarget(ctx) {
      const body = parse(targetCreate, ctx.body, "Send { \"token\": \"<bot token from BotFather>\" }.");
      const { target, replaced } = await svc().addTarget({ token: body.token, label: body.label });
      await audit(ctx, replaced ? "notify.target_updated" : "notify.target_added", { targetId: target.id, kind: target.kind });
      return json({ data: { ...target, replaced }, meta: meta(ctx) }, { status: replaced ? 200 : 201, headers: NO_STORE });
    },
    async deleteTarget(ctx) {
      const id = targetId(ctx);
      await svc().removeTarget(id);
      await audit(ctx, "notify.target_removed", { targetId: id });
      return noContent();
    },
    async testTarget(ctx) {
      const body = parse(testBody, ctx.body);
      return json({ data: await svc().testTarget(targetId(ctx), { chatKey: body.chat }), meta: meta(ctx) }, { headers: NO_STORE });
    },
    async findChat(ctx) {
      return json({ data: await svc().findChats(targetId(ctx)), meta: meta(ctx) }, { headers: NO_STORE });
    },
    async addChat(ctx) {
      const body = parse(chatAdd, ctx.body, "Send { \"ref\": \"<from Find my chat>\" }.");
      const id = targetId(ctx);
      const chat = await svc().addChat(id, body);
      await audit(ctx, "notify.chat_added", { targetId: id, chat: chat.key, commands: chat.commands });
      return json({ data: chat, meta: meta(ctx) }, { status: 201, headers: NO_STORE });
    },
    async patchChat(ctx) {
      const body = parse(chatPatch, ctx.body, "Send { \"commands\": true|false }.");
      const id = targetId(ctx);
      const chat = await svc().setChatCommands(id, chatKey(ctx), body.commands);
      await audit(ctx, "notify.chat_changed", { targetId: id, chat: chat.key, commands: chat.commands });
      return { data: chat, meta: meta(ctx) };
    },
    async deleteChat(ctx) {
      const id = targetId(ctx);
      const key = chatKey(ctx);
      await svc().removeChat(id, key);
      await audit(ctx, "notify.chat_removed", { targetId: id, chat: key });
      return noContent();
    },
    async getEvents(ctx) {
      return { data: svc().events(), meta: meta(ctx) };
    },
    async putEvents(ctx) {
      const body = parse(eventsPut, ctx.body, "Send { \"events\": { \"order.filled\": true } } (see GET /v1/notify/events for the names).");
      const data = svc().setEvents(body);
      await audit(ctx, "notify.events_changed", { events: body.events ?? null, quietHours: body.quietHours ? true : false, morning: body.morning ? true : false });
      return { data, meta: meta(ctx) };
    },
  };
}
