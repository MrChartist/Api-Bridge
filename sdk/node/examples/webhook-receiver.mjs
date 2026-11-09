// A tiny webhook receiver that checks the Bridge's signature before it trusts a delivery.
//   MCB_WEBHOOK_SECRET=... node webhook-receiver.mjs [PORT]
// Register it (from the Bridge's computer, with an admin key; the URL must be https unless the Bridge allows a local target):
//   await bridge.subscriptions.create({ url: "https://your.host/hook", topics: ["download.done"], secret: SECRET });
import http from "node:http";
import { verifyRequest } from "@mrchartist/bridge-client";

const SECRET = process.env.MCB_WEBHOOK_SECRET;
if (!SECRET) throw new Error("set MCB_WEBHOOK_SECRET");

http
  .createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks); // the exact bytes as received: never re-serialise parsed JSON before verifying
      if (!verifyRequest(SECRET, req.headers, raw)) {
        res.writeHead(401).end();
        return;
      }
      const event = JSON.parse(raw.toString("utf8"));
      console.log("verified:", event.topic, event.data);
      res.writeHead(204).end();
    });
  })
  .listen(Number(process.argv[2] ?? 8099), "127.0.0.1");
