/**
 * WebSocket endpoint for /v1/stream (docs/asyncapi.yaml). Core's upgrade pipeline has already checked the Host and
 * Origin headers (DNS rebinding, CORS allowlist); this file authenticates, enforces the connection cap and wires the
 * socket to a protocol session.
 *
 * Auth: `?token=` stream token (single use, 60 s) or an Authorization / X-API-Key header from scripts. Refusals use
 * plain HTTP status lines because no WebSocket exists yet: 401 (no or bad credentials), 403 (scope), 429 (too many
 * connections). Liveness: a protocol-level ping every heartbeat; a socket that misses two pongs is terminated.
 */
import { WebSocketServer } from "ws";
import { authenticateStream, createClientSession, newClientId } from "./protocol.mjs";

/** Largest client frame accepted (a subscribe for 1,000 long symbols fits comfortably). */
export const MAX_CLIENT_FRAME_BYTES = 64 * 1024;

/**
 * @param {{ hub: object, bus: object, keyStore: object, registry: ReturnType<typeof import("./protocol.mjs").createSessionRegistry>,
 *   config: object, clock: { now(): number }, logger: object }} opts
 * @returns {{ handleUpgrade(args: { req: any, socket: any, head: Buffer, url: URL, log?: object, reject: (statusLine: string) => void }): Promise<void>, close(): void }}
 */
export function createWsEndpoint({ hub, bus, keyStore, registry, config: cfg, clock, logger, scheduler = null, localAccess = null }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_CLIENT_FRAME_BYTES, perMessageDeflate: false, clientTracking: false });

  async function handleUpgrade({ req, socket, head, url, reject, viaPublicIngress = false }) {
    let key;
    try {
      key = await authenticateStream({ keyStore, query: url.searchParams, headers: req.headers, local: localAccess ? () => localAccess.recordFor(req, { publicListener: viaPublicIngress }) : null });
    } catch (err) {
      reject(err?.code === "SCOPE_REQUIRED" ? "403 Forbidden" : "401 Unauthorized");
      return;
    }
    if (registry.full() || registry.fullFor?.(key.id)) {
      reject("429 Too Many Requests");
      return;
    }
    if (socket.destroyed) return;
    wss.handleUpgrade(req, socket, head, (ws) => attach(ws, socket, key));
  }

  function attach(ws, socket, key) {
    const id = newClientId("ws");
    const transport = {
      kind: "ws",
      write: (msg) => ws.send(JSON.stringify(msg)),
      bufferedBytes: () => ws.bufferedAmount,
      close: (code, reason) => {
        if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.close(code, String(reason ?? "").slice(0, 120));
      },
      onDrain: (cb) => socket.once("drain", cb),
    };
    const session = createClientSession({ id, kind: "ws", key, hub, bus, transport, config: cfg, clock, logger, keyStore, scheduler, onClosed: (s) => registry.remove(s) });
    registry.add(session);

    let alive = true;
    const liveness = setInterval(() => {
      if (!alive) {
        ws.terminate();
        return;
      }
      alive = false;
      try {
        ws.ping();
      } catch {
        /* closing */
      }
    }, cfg.heartbeatMs * 2);
    liveness.unref?.();
    ws.on("pong", () => {
      alive = true;
    });
    ws.on("message", (data, isBinary) => {
      alive = true;
      if (isBinary) {
        session.handleOp({ op: "binary" }); // answered with VALIDATION_FAILED
        return;
      }
      session.handleMessage(data.toString("utf8"));
    });
    ws.on("error", () => {
      /* the close event follows */
    });
    ws.on("close", () => {
      clearInterval(liveness);
      session.close("closed", false);
    });
  }

  return {
    handleUpgrade,
    close() {
      wss.close();
    },
  };
}
