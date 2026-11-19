/**
 * Tick research: record every tick, read stored ticks in place, write a signal once, run it on history and live (or a
 * replay through the live path), and prove the two give identical output tick by tick.
 *
 *   live feeds ─► StreamHub ─"tick"─► tick log (tickLog.mjs)          bounded memory, nothing dropped silently
 *                                         │
 *   stored ticks (store.mjs): tick log · recordings · any SQL store (DuckDB/Parquet/S3, Postgres, QuestDB, ClickHouse ...)
 *        │                                    │
 *        ▼ runHistorical (runner.mjs)          ▼ replay adapter (replay.mjs) ─► StreamHub ─► runLive (runner.mjs)
 *   historical outputs ──────────► compareRuns (compare.mjs) ◄────────── live outputs
 *
 * Guide: docs/guides/tick-research.md.
 */
export { createTickLog, encodeTick, decodeTick, lastSeqOf, tickFileName } from "./tickLog.mjs";
export { createTickLogStore, createRecordingStore, createSqlTickStore, createArrayStore, auditTickLog, assertTickStore, compareTicks, TICK_FIELDS, DEFAULT_SQL_COLUMNS } from "./store.mjs";
export { defineSignal, compensatedSum, windowSum, windowExtremes, ema, asof, deltaOf, mid, spread, microprice, imbalance, logReturn } from "./signal.mjs";
export { createSignalRunner, runHistorical, runLive, asHubTick } from "./runner.mjs";
export { createReplayAdapter, createReplayClock, canonicalRef } from "./replay.mjs";
export { compareRuns, valuesEqual } from "./compare.mjs";
