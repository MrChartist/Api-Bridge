# API reference: one page per endpoint

169 operations, generated from [openapi.yaml](../openapi.yaml). Each page lists the scope, whether it works only from this computer, parameters, request and response fields, error codes, and a curl and Python example. Streams are in [asyncapi.yaml](../asyncapi.yaml); error codes in [errors.md](errors.md).

Every call except `/v1/health`, inbound webhooks and the streaming endpoints needs an API key (`Authorization: Bearer mcb_<keyId>_<secret>`). Scopes: `read`, `paper` (read plus paper orders), `live`, `admin` (this computer only). Orders are paper unless a request says `"mode": "live"` and every live opt-in is in place ([safety.md](../guides/safety.md)).

Try the calls without code: [Postman and Bruno collections](../collections/README.md).

## System

Health, versions and this document.

| Call | What it does | Needs |
|---|---|---|
| [GET /v1/health](system/getHealth.md) | Liveness check | no key |
| [GET /](system/getRoot.md) | Redirect to the local dashboard | no key |
| [GET /dashboard](system/getDashboard.md) | Local dashboard (HTML; this computer only) | no key |
| [GET /dashboard/{file}](system/getDashboardAsset.md) | Dashboard scripts, stylesheet and logo | no key |
| [GET /v1/meta](system/getMeta.md) | Versions, brokers, modules and routes | `read` |
| [GET /v1/requests](system/listRecentRequests.md) | Recent requests to this Bridge (newest first) | `admin`, this computer only |
| [GET /v1/expose](system/getExposure.md) | What is set up to be reached from outside this computer | `admin`, this computer only |
| [POST /v1/expose/check](system/checkExposure.md) | Check that only the intended routes answer on the public listeners | `admin`, this computer only |
| [GET /openapi.yaml](system/getOpenApi.md) | This document | no key |

## Accounts

Your broker accounts, sessions and broker capabilities.

| Call | What it does | Needs |
|---|---|---|
| [GET /v1/brokers](accounts/listBrokers.md) | Supported brokers and what each can do | `read` |
| [GET /v1/accounts](accounts/listAccounts.md) | Your configured accounts and their session state | `read` |
| [POST /v1/accounts](accounts/addAccount.md) | Add a broker or paper account (saved to the config file, usable at once) | `admin`, this computer only |
| [GET /v1/accounts/{accountId}](accounts/getAccount.md) | One account | `read` |
| [DELETE /v1/accounts/{accountId}](accounts/removeAccount.md) | Remove an account (from the config file and the running Bridge) | `admin`, this computer only |
| [POST /v1/accounts/{accountId}/session](accounts/connectAccount.md) | Connect or log in to the broker | `admin`, this computer only |
| [DELETE /v1/accounts/{accountId}/session](accounts/disconnectAccount.md) | Forget the broker session (saved keys stay) | `admin`, this computer only |
| [POST /v1/accounts/{accountId}/test](accounts/testAccount.md) | Make one cheap authenticated broker call | `read` |

## Keys

Bridge API keys and their scopes.

| Call | What it does | Needs |
|---|---|---|
| [GET /v1/keys](keys/listKeys.md) | List API keys (never the key itself) | `admin`, this computer only |
| [POST /v1/keys](keys/createKey.md) | Create an API key | `admin`, this computer only |
| [DELETE /v1/keys/{keyId}](keys/revokeKey.md) | Revoke a key (takes effect immediately) | `admin`, this computer only |
| [POST /v1/sign-in](keys/signIn.md) | Exchange a one-time sign-in code for a dashboard key | no key |

## Instruments

Instrument search, resolution and symbol conversion.

| Call | What it does | Needs |
|---|---|---|
| [GET /v1/instruments/search](instruments/searchInstruments.md) | Search instruments across connected brokers' masters | `read` |
| [GET /v1/instruments/{symbol}](instruments/getInstrument.md) | Resolve one instrument (lot size, tick size, freeze quantity) | `read` |
| [GET /v1/symbols/convert](instruments/convertSymbolGet.md) | Convert one symbol between formats | `read` |
| [POST /v1/symbols/convert](instruments/convertSymbols.md) | Convert up to 200 symbols in one call | `read` |
| [GET /v1/symbols/resolve](instruments/resolveSymbol.md) | Resolve a name to one instrument, with the reason | `read` |
| [GET /v1/symbols/validate](instruments/validateSymbolGet.md) | Check one symbol (canonical form, lot size, tradable) | `read` |
| [POST /v1/symbols/validate](instruments/validateSymbols.md) | Check up to 200 symbols in one call | `read` |

## Market data

Quotes, LTP, depth, history, expiries and option chains, served streaming-first within broker limits.

| Call | What it does | Needs |
|---|---|---|
| [GET /v1/ltp](market-data/getLtp.md) | Last traded price for up to 200 symbols | `read` |
| [GET /v1/quotes](market-data/getQuotes.md) | Full quotes for up to 200 symbols | `read` |
| [GET /v1/depth](market-data/getDepth.md) | Market depth (5 levels where the broker offers it) | `read` |
| [GET /v1/history](market-data/getHistory.md) | Historical candles, automatically split across broker limits | `read` |
| [GET /v1/expiries](market-data/getExpiries.md) | Expiry dates for an underlying | `read` |
| [GET /v1/optionchain](market-data/getOptionChain.md) | Option chain with IV and Greeks | `read` |
| [GET /v1/calendar/holidays](market-data/getCalendarHolidays.md) | Trading holidays of a year for an exchange | `read` |
| [GET /v1/calendar/sessions](market-data/getCalendarSessions.md) | The session of one date (trading day or not, and the times) | `read` |
| [GET /v1/calendar/status](market-data/getCalendarStatus.md) | Is the exchange open now, and when does it next open | `read` |

## Streaming

WebSocket and SSE live data.

| Call | What it does | Needs |
|---|---|---|
| [POST /v1/stream/token](streaming/createStreamToken.md) | Short-lived token for WebSocket and SSE URLs | `read` |
| [GET /v1/stream](streaming/openStream.md) | WebSocket stream (upgrade) | no key |
| [GET /v1/stream/sse](streaming/openSse.md) | Server-Sent Events stream (same messages as the WebSocket) | no key |
| [GET /v1/stream/stats](streaming/getStreamStats.md) | Upstream feeds, subscriptions and clients | `read` |

## Portfolio

Positions, holdings and funds per account.

| Call | What it does | Needs |
|---|---|---|
| [GET /v1/positions](portfolio/getPositions.md) | Positions for one account (live from the broker, or paper) | `read` |
| [POST /v1/positions/convert](portfolio/convertPosition.md) | Convert a position between Intraday (MIS) and carry (NRML) | `paper` |
| [GET /v1/holdings](portfolio/getHoldings.md) | Demat holdings for one account | `read` |
| [GET /v1/funds](portfolio/getFunds.md) | Funds and margin for one account | `read` |
| [POST /v1/margin/basket](portfolio/marginBasket.md) | Margin for up to 50 prospective positions (read only) | `read` |

## Orders

Paper and live orders with idempotency and safety checks.

| Call | What it does | Needs |
|---|---|---|
| [GET /v1/orders](orders/listOrders.md) | Orders (newest first) | `read` |
| [POST /v1/orders](orders/placeOrder.md) | Place an order (paper unless you ask for live) | `paper` |
| [POST /v1/orders/preview](orders/previewOrder.md) | Check an order without sending it | `paper` |
| [POST /v1/orders/to-target](orders/placeOrderToTarget.md) | Place only the order that gets a position to a target size | `paper` |
| [POST /v1/orders/batch](orders/placeOrderBatch.md) | Place up to 20 independent orders in one call | `paper` |
| [POST /v1/orders/cancel-all](orders/cancelAllOrders.md) | Cancel every open order for an account (or all accounts this key may use) | `paper` |
| [GET /v1/orders/by-client-id/{clientOrderId}](orders/getOrderByClientId.md) | Look up an order by your own clientOrderId | `read` |
| [GET /v1/orders/{orderId}](orders/getOrder.md) | One order (refreshed from the broker for live orders) | `read` |
| [PATCH /v1/orders/{orderId}](orders/modifyOrder.md) | Modify an open order | `paper` |
| [DELETE /v1/orders/{orderId}](orders/cancelOrder.md) | Cancel an open order | `paper` |
| [GET /v1/trades](orders/listTrades.md) | Executions (trade book) | `read` |
| [GET /v1/tickets](orders/listTickets.md) | Orders waiting for a human confirmation | `admin`, this computer only |
| [POST /v1/tickets/{ticketId}/confirm](orders/confirmTicket.md) | Human confirmation of an order prepared by an AI assistant or webhook | `admin`, this computer only |
| [POST /v1/tickets/{ticketId}/reject](orders/rejectTicket.md) | A person declines an order prepared by an AI assistant or webhook | `admin`, this computer only |

## Paper

The paper-trading engine.

| Call | What it does | Needs |
|---|---|---|
| [GET /v1/paper/accounts/{accountId}](paper/getPaperAccount.md) | Paper account summary | `read` |
| [POST /v1/paper/accounts/{accountId}/reset](paper/resetPaperAccount.md) | Clear paper orders and positions and start again | `paper` |
| [POST /v1/paper/accounts/{accountId}/reset/undo](paper/undoPaperReset.md) | Put back the paper book from before the last reset | `paper` |
| [GET /v1/paper/accounts/{accountId}/daily](paper/paperDailyPnl.md) | Daily P&L snapshots of a paper account, oldest first | `read` |
| [POST /v1/paper/accounts/{accountId}/daily](paper/paperDailySnapshot.md) | Take today's P&L snapshot now | `paper` |
| [POST /v1/paper/accounts/{accountId}/margin](paper/paperBasketMargin.md) | Margin of a basket against the paper book (approximate, nothing is placed) | `read` |

## Limits

Broker limits, budgets and usage.

| Call | What it does | Needs |
|---|---|---|
| [GET /v1/limits](limits/getLimits.md) | Broker limits, safety limits and current budgets per account | `read` |
| [GET /v1/usage](limits/getUsage.md) | How much of each budget is used, queued and saved by streaming, caching and coalescing | `read` |

## Sources

Where market data comes from besides your broker accounts (free providers, plugins), with honest labels, terms, health and a routing trace.

| Call | What it does | Needs |
|---|---|---|
| [GET /v1/sources](sources/listSources.md) | Data sources, what each one is, and whether it is on | `read` |
| [GET /v1/sources/trace](sources/traceSources.md) | Why a read would be served by one source and not another (dry run) | `read` |
| [PATCH /v1/sources/settings](sources/updateSourcesSettings.md) | Use free sources automatically when your brokers cannot answer | `admin`, this computer only |
| [PATCH /v1/sources/{id}](sources/updateSource.md) | Turn a source on or off | `admin`, this computer only |
| [PUT /v1/sources/{id}/config](sources/configureSource.md) | Store the API key of a source that needs one | `admin`, this computer only |
| [POST /v1/sources/{id}/test](sources/testSource.md) | Check that a source answers | `admin`, this computer only |

## Pooling

Spreading read-only market data over your own accounts of one holder. Off until you accept a notice; orders never pool.

| Call | What it does | Needs |
|---|---|---|
| [GET /v1/pooling](pooling/getPooling.md) | Whether market-data reads may be spread over your own accounts | `read` |
| [PUT /v1/pooling/consent](pooling/acceptPooling.md) | Accept the pooling notice for chosen accounts | `admin`, this computer only |
| [DELETE /v1/pooling/consent](pooling/revokePooling.md) | Withdraw the pooling consent | `admin`, this computer only |

## Quotas

Per-key request quotas and fair-queue weights.

| Call | What it does | Needs |
|---|---|---|
| [GET /v1/quotas](quotas/getQuotas.md) | Each API key's share of the Bridge | `read` |
| [PUT /v1/quotas/{keyId}](quotas/setQuota.md) | Override one key's quota or weight | `admin`, this computer only |
| [DELETE /v1/quotas/{keyId}](quotas/clearQuota.md) | Remove a key's override | `admin`, this computer only |

## Notifications

Events to Telegram and a few read-only Telegram commands. Setup is on this computer only; nothing here returns a bot token or a chat id.

| Call | What it does | Needs |
|---|---|---|
| [GET /v1/notify/status](notifications/getNotifyStatus.md) | Notification health: queue, last delivery, last error per target | `admin` |
| [GET /v1/notify/targets](notifications/listNotifyTargets.md) | List Telegram bots and their chats (masked) | `admin` |
| [POST /v1/notify/targets](notifications/createNotifyTarget.md) | Add a Telegram bot (or replace the token of the same bot) | `admin`, this computer only |
| [DELETE /v1/notify/targets/{targetId}](notifications/deleteNotifyTarget.md) | Remove a bot and forget its token and chats | `admin`, this computer only |
| [POST /v1/notify/targets/{targetId}/test](notifications/testNotifyTarget.md) | Send a test message and report delivery per chat | `admin`, this computer only |
| [POST /v1/notify/targets/{targetId}/find-chat](notifications/findNotifyChat.md) | Find chats that recently wrote to the bot | `admin`, this computer only |
| [POST /v1/notify/targets/{targetId}/chats](notifications/addNotifyChat.md) | Put a chat on the list (alerts, and optionally commands) | `admin`, this computer only |
| [PATCH /v1/notify/targets/{targetId}/chats/{chatKey}](notifications/updateNotifyChat.md) | Allow or stop commands from a chat | `admin`, this computer only |
| [DELETE /v1/notify/targets/{targetId}/chats/{chatKey}](notifications/deleteNotifyChat.md) | Remove a chat from the list | `admin`, this computer only |
| [GET /v1/notify/events](notifications/getNotifyEvents.md) | Every event with its plain label and whether it is on | `admin` |
| [PUT /v1/notify/events](notifications/putNotifyEvents.md) | Choose which events are sent, quiet hours and the morning reminder | `admin`, this computer only |

## Recordings

Saves this Bridge's own real-time data going forward (quotes, option chains) to files on this computer, by hand or by rules every trading day. Real-time class only.

| Call | What it does | Needs |
|---|---|---|
| [GET /v1/recordings](recordings/listRecordings.md) | List recordings (meta.status is a plain status line) | `read` |
| [POST /v1/recordings](recordings/createRecording.md) | Start a recording of quotes or an option chain | `admin`, this computer only |
| [GET /v1/recordings/status](recordings/getRecordingsStatus.md) | One plain line about today's recording, and the numbers behind it | `read` |
| [GET /v1/recordings/auto](recordings/getRecordingAuto.md) | Whether auto-record is on | `read` |
| [PUT /v1/recordings/auto](recordings/putRecordingAuto.md) | Turn auto-record on or off | `admin`, this computer only |
| [GET /v1/recordings/presets](recordings/listRecordingPresets.md) | The one-click presets | `read` |
| [POST /v1/recordings/presets/{presetId}/apply](recordings/applyRecordingPreset.md) | Create the preset's rule and turn auto-record on | `admin`, this computer only |
| [GET /v1/recordings/rules](recordings/listRecordingRules.md) | The auto-record rules | `read` |
| [POST /v1/recordings/rules](recordings/createRecordingRule.md) | Add an auto-record rule | `admin`, this computer only |
| [GET /v1/recordings/rules/{ruleId}](recordings/getRecordingRule.md) | One rule with today's state | `read` |
| [PATCH /v1/recordings/rules/{ruleId}](recordings/patchRecordingRule.md) | Change a rule | `admin`, this computer only |
| [DELETE /v1/recordings/rules/{ruleId}](recordings/deleteRecordingRule.md) | Delete a rule (its files stay unless deleteFiles=true) | `admin`, this computer only |
| [GET /v1/recordings/{id}](recordings/getRecording.md) | One recording: counters, gaps, disk use, files summary | `read` |
| [DELETE /v1/recordings/{id}](recordings/deleteRecording.md) | Delete a recording and its files | `admin`, this computer only |
| [POST /v1/recordings/{id}/pause](recordings/pauseRecording.md) | Pause a recording | `admin`, this computer only |
| [POST /v1/recordings/{id}/resume](recordings/resumeRecording.md) | Resume a paused recording | `admin`, this computer only |
| [POST /v1/recordings/{id}/stop](recordings/stopRecording.md) | Stop a recording (final; the files stay) | `admin`, this computer only |
| [GET /v1/recordings/{id}/files](recordings/listRecordingFiles.md) | The day files of a recording | `read` |
| [GET /v1/recordings/{id}/files/{name}](recordings/getRecordingFile.md) | Download one day file as it is on disk | `read` |

## Safety

Kill switch, safety counters and the audit log.

| Call | What it does | Needs |
|---|---|---|
| [GET /v1/safety](safety/getSafety.md) | Kill switch, live-trading state and today's safety counters | `read` |
| [POST /v1/safety/kill-switch](safety/engageKillSwitch.md) | Stop all orders now (any key may do this) | `read` |
| [DELETE /v1/safety/kill-switch](safety/releaseKillSwitch.md) | Release the kill switch (admin, this computer only) | `admin`, this computer only |
| [GET /v1/audit](safety/queryAudit.md) | Read the append-only audit log | `admin`, this computer only |
| [GET /v1/audit/verify](safety/verifyAudit.md) | Check the audit log's hash chain | `admin`, this computer only |

## Readiness

Whether each live account can trade now: session, static IP, order headroom, kill switch.

| Call | What it does | Needs |
|---|---|---|
| [GET /v1/readiness](readiness/getReadiness.md) | Trading readiness of each live account (cached; no broker call) | `read` |
| [POST /v1/readiness/check](readiness/checkReadiness.md) | Re-check now (probe and egress lookup, each with a 30 s cooldown) | `read` |
| [GET /v1/readiness/history](readiness/getReadinessHistory.md) | Recent readiness transitions (newest first) | `read` |
| [POST /v1/demo/readiness](readiness/demoReadinessScenario.md) | Demo mode only - simulate a readiness failure on the demo account (restores itself after 10 minutes) | `read` |

## Backup

Copies of your data folder (keys store, accounts, state, paper books, audit log), made on this computer only. The archive is never served over HTTP.

| Call | What it does | Needs |
|---|---|---|
| [GET /v1/backup](backup/getBackup.md) | The last backup, the schedule and the copies kept on this computer | `admin`, this computer only |
| [POST /v1/backup](backup/createBackup.md) | Make a backup now | `admin`, this computer only |

## Spreadsheets

Plain-text and CSV endpoints for Excel, Google Sheets and AmiBroker.

| Call | What it does | Needs |
|---|---|---|
| [GET /xl/ltp](spreadsheets/xlLtp.md) | One number as plain text, for Excel WEBSERVICE and AmiBroker | `read` |
| [GET /xl/quote](spreadsheets/xlQuote.md) | One quote field as plain text | `read` |
| [GET /xl/chain](spreadsheets/xlChain.md) | Flat option chain table (CSV or JSON records) for Power Query and Sheets | `read` |
| [GET /xl/history](spreadsheets/xlHistory.md) | Candles as CSV (layout=amibroker matches the shipped AmiBroker import format) | `read` |
| [GET /xl/quotes](spreadsheets/xlQuotes.md) | Prices for a whole sheet as one table (one request, one row per symbol) | `read` |
| [GET /xl/instrument](spreadsheets/xlInstrument.md) | Lot size, tick size and freeze quantity | `read` |
| [GET /xl/positions](spreadsheets/xlPositions.md) | Positions of every account the key may use, as one table | `read` |
| [GET /xl/holdings](spreadsheets/xlHoldings.md) | Holdings as one table | `read` |
| [GET /xl/funds](spreadsheets/xlFunds.md) | Funds, one row per account | `read` |
| [GET /xl/orders](spreadsheets/xlOrders.md) | Orders as one table, newest first | `read` |

## Webhooks

Inbound alerts from ChartInk, GoCharting and signed senders.

| Call | What it does | Needs |
|---|---|---|
| [POST /hooks/{source}/{token}](webhooks/receiveHook.md) | Inbound alert (TradingView, signed generic, ChartInk or GoCharting) | no key |
| [GET /v1/hooks](webhooks/listHooks.md) | List configured hooks (never the token) | `admin`, this computer only |
| [POST /v1/hooks](webhooks/createHook.md) | Create a hook; the URL with its token is shown once | `admin`, this computer only |
| [DELETE /v1/hooks/{hookId}](webhooks/deleteHook.md) | Delete a hook (its URL stops working immediately) | `admin`, this computer only |
| [GET /v1/hooks/presets](webhooks/getHookPresets.md) | Address presets, trusted-tunnel header and public hosts, for building a hook | `admin`, this computer only |
| [GET /v1/hooks/{hookId}/signals](webhooks/listHookSignals.md) | Recent alerts of one hook, with what happened to each | `admin`, this computer only |
| [POST /v1/hooks/{hookId}/test](webhooks/testHook.md) | Send a test alert through the real pipeline, as a paper order | `admin`, this computer only |

## AI (MCP)

Model Context Protocol endpoint for AI assistants.

| Call | What it does | Needs |
|---|---|---|
| [POST /mcp](ai-mcp/mcp.md) | MCP Streamable HTTP endpoint for AI assistants | `read` |

## Compat REST

Endpoints in the common apikey-in-body style (POST JSON, `apikey` in the body, { status, ... } replies) so SDKs and add-ins written for that style work against the Bridge. Same services, limits and safety as /v1; orders are paper while analyzer mode is on.

| Call | What it does | Needs |
|---|---|---|
| [POST /api/v1/ping](compat-rest/compatPing.md) | Check the key and the account the calls act on | `apikey` in body |
| [POST /api/v1/analyzer](compat-rest/compatAnalyzer.md) | Analyzer (paper) mode status for this key | `apikey` in body |
| [POST /api/v1/analyzer/toggle](compat-rest/compatAnalyzerToggle.md) | Switch analyzer mode for this key (off needs a live key) | `apikey` in body |
| [POST /api/v1/funds](compat-rest/compatFunds.md) | Funds | `apikey` in body |
| [POST /api/v1/orderbook](compat-rest/compatOrderbook.md) | Order book with statistics | `apikey` in body |
| [POST /api/v1/tradebook](compat-rest/compatTradebook.md) | Trade book | `apikey` in body |
| [POST /api/v1/positionbook](compat-rest/compatPositionbook.md) | Positions | `apikey` in body |
| [POST /api/v1/holdings](compat-rest/compatHoldings.md) | Holdings with statistics | `apikey` in body |
| [POST /api/v1/placeorder](compat-rest/compatPlaceorder.md) | Place an order | `apikey` in body |
| [POST /api/v1/placesmartorder](compat-rest/compatPlacesmartorder.md) | Order towards a target position size | `apikey` in body |
| [POST /api/v1/basketorder](compat-rest/compatBasketorder.md) | Several orders in one call | `apikey` in body |
| [POST /api/v1/splitorder](compat-rest/compatSplitorder.md) | One order split into pieces | `apikey` in body |
| [POST /api/v1/modifyorder](compat-rest/compatModifyorder.md) | Modify an open order | `apikey` in body |
| [POST /api/v1/cancelorder](compat-rest/compatCancelorder.md) | Cancel an order | `apikey` in body |
| [POST /api/v1/cancelallorder](compat-rest/compatCancelallorder.md) | Cancel every open order | `apikey` in body |
| [POST /api/v1/closeposition](compat-rest/compatCloseposition.md) | Square off every open position | `apikey` in body |
| [POST /api/v1/orderstatus](compat-rest/compatOrderstatus.md) | One order's status | `apikey` in body |
| [POST /api/v1/openposition](compat-rest/compatOpenposition.md) | Net quantity for one symbol and product | `apikey` in body |
| [POST /api/v1/optionsorder](compat-rest/compatOptionsorder.md) | Order an option by offset (ATM, ITM2, OTM1 ...) | `apikey` in body |
| [POST /api/v1/quotes](compat-rest/compatQuotes.md) | Quote for one symbol | `apikey` in body |
| [POST /api/v1/multiquotes](compat-rest/compatMultiquotes.md) | Quotes for up to 200 symbols | `apikey` in body |
| [POST /api/v1/depth](compat-rest/compatDepth.md) | Market depth | `apikey` in body |
| [POST /api/v1/history](compat-rest/compatHistory.md) | Candles | `apikey` in body |
| [POST /api/v1/intervals](compat-rest/compatIntervals.md) | Supported candle intervals | `apikey` in body |
| [POST /api/v1/symbol](compat-rest/compatSymbol.md) | Instrument details | `apikey` in body |
| [POST /api/v1/search](compat-rest/compatSearch.md) | Instrument search | `apikey` in body |
| [POST /api/v1/expiry](compat-rest/compatExpiry.md) | Expiry dates | `apikey` in body |
| [POST /api/v1/optionchain](compat-rest/compatOptionchain.md) | Option chain | `apikey` in body |
| [POST /api/v1/optionsymbol](compat-rest/compatOptionsymbol.md) | Option symbol for an offset | `apikey` in body |
| [POST /api/v1/margin](compat-rest/compatMargin.md) | Margin calculation (not available yet) | `apikey` in body |
