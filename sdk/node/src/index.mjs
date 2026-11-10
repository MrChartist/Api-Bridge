/**
 * @mrchartist/bridge-client — Node client for the Mr. Chartist API Bridge.
 * Types: index.d.ts (hand-written against docs/openapi.yaml).
 */
export { BridgeClient, DEFAULT_BASE_URL, newIdempotencyKey, toQuery } from "./client.mjs";
export { BridgeApiError, BridgeConnectionError, BridgeError, ChecksumMismatchError, DownloadFailedError, SignatureInvalidError, WaitTimeoutError } from "./errors.mjs";
export { BridgeStream } from "./stream.mjs";
export { Collections, Datasets, Downloads, Recordings, Subscriptions, describeDataClass, optionUniverse, parseTable, toCsv } from "./data.mjs";
export { ATTEMPT_HEADER, DELIVERY_HEADER, EVENT_ID_HEADER, EVENT_TOPIC_HEADER, EventSubscription, Events, SIGNATURE_HEADER, TIMESTAMP_HEADER, computeSignature, eventFrom, explainSignature, parseSse, signPayload, topicMatches, verifyRequest, verifySignature } from "./events.mjs";
export { HistoryAll, istIso, leastCurrent, toEpochSeconds } from "./history.mjs";
