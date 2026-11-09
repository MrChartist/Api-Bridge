/**
 * The modules the Bridge boots, in registration order. Core-owned: a stream adds nothing here; it fills in its own
 * module.mjs. Order matters only for route registration logs and stop() order (reverse).
 */
import accounts from "../accounts/module.mjs";
import auth from "../auth/module.mjs";
import ratelimit from "../ratelimit/module.mjs";
import symbols from "../symbols/module.mjs";
import market from "../market/module.mjs";
import stream from "../stream/module.mjs";
import orders from "../orders/module.mjs";
import paper from "../paper/module.mjs";
import safety from "../safety/module.mjs";
import readiness from "../readiness/module.mjs";
import integrations from "../integrations/module.mjs";
import hooks from "../hooks/module.mjs";
import mcp from "../mcp/module.mjs";
import compat from "../compat/module.mjs";
import sources from "../sources/module.mjs";
import backup from "../backup/module.mjs";
import notify from "../notify/module.mjs";
import downloads from "../downloads/module.mjs";

export const BUILTIN_MODULES = Object.freeze([accounts, auth, ratelimit, symbols, market, stream, orders, paper, safety, readiness, integrations, hooks, mcp, compat, sources, backup, notify, downloads]);
