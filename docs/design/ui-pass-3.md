# UI pass 3: no strips, one elevation scale, merged pages, a clean menu

Status: ready to build. Scope: every page of `server/bridge/dashboard/`. Builds on `docs/design/foundation.md` (tokens, selection pair, desk shell), `docs/theme/TYPE-SYSTEM.md` and `docs/theme/BUTTON-SYSTEM.md` (incl. "Dashboard adaptation"). Nothing here overrides those; where a rule below touches type or buttons it stays inside them (Chartist fonts only, ≥12px, ≤600 weight, no em dash in visible text, true minus sign; six button intents, glass capsules, only Buy/Sell coloured, focus ring inside, no hover lift).

Evidence: the three audits of this pass (shell + overview pages, Options desk, Options data pages). Screenshots under `/tmp/claude-0/-home-user-api-bridge/f0059dc2-aa37-55ea-b3a6-c17ba0d3d4a5/scratchpad/ui3/{shell,desk/keep,optdata}/`.

Build order: **Foundation first (one builder)**, then **three page areas in parallel**. Section 9 maps every audit finding to a task or a rejection.

---

## 1. The no-strip rule

**Rule.** No element may carry a coloured or contrasting edge on fewer than four sides as decoration or as a state signal. Banned forms:

- `border-left|right|top|bottom` in a colour different from the other sides, or on one side only (a single bottom row rule in a table/list is a *separator*, see §1.3, not a strip);
- `box-shadow: inset Npx 0 0 …` / `inset 0 Npx 0 …` / `inset 0 -Npx 0 …` with N ≥ 1.5px in any colour other than the separator token, or any one-sided inset in an accent/status/selection colour;
- `::before`/`::after` bars (width or height ≤ 4px) placed along one edge;
- coloured top rules on panels, banners, headers (`th` underlines in call/put colours included);
- kicker lines (a rule running from a heading to the edge), numbered eyebrow pills;
- one-sided gradient fades used as decoration (a fade is allowed only as a live overflow hint, §1.4);
- directional "rim" gradients that make one corner brighter.

**Data marks are not strips.** OI bars, P&L bars, IV heat, gauges, meters, sparklines, payoff curves, the margin bar and the ATM band fill stay as they are.

### 1.1 What replaces each kind of strip

| Was | Now | Tokens |
|---|---|---|
| Current nav item (sidebar leading bar) | Fill + contrast: background `var(--mat-fill-3)`, text `hsl(var(--foreground))`, weight 600, glyph stroke-width 2.4. No `::before`. Forced-colors keeps its outline. | `--mat-fill-3` |
| Current row in a list / More sheet | Fill `var(--mat-fill-2)` + a trailing check icon (`icon("check")`, `--sel-bg` ink) in place of the chevron. | `--mat-fill-2` |
| Selected table row (chain focus, OI strike, vol expiry/strike, screener, arb, positions, recorder "mine") | **Whole-row fill**: every cell `background: linear-gradient(var(--mat-fill-2), var(--mat-fill-2)), var(--mat-grouped-solid)` (the solid layer keeps sticky cells opaque) plus weight 600 on the lead cell. A pill in the row (strike `.kv`, "Yours") may take the contrast pair `--sel-bg/--sel-fg`. | `--mat-fill-2`, `--sel-*` |
| Keyboard cursor / focused row | Whole ring on the row: `tr:focus-visible { outline: 2px solid var(--sel-ring); outline-offset: -2px }` (or `inset 0 0 0 2px var(--sel-ring)` on a cell/button). Never 1-3 sides. | `--sel-ring` |
| "Current spot" row / target column in a grid | Fill-2 header cell + 600 weight; a target column is tinted whole (`hsl(var(--c-atm)/0.12)` + atm ink), outlined on both sides if needed. | |
| Status on a card/tile/banner (good/bad/stale/edge) | Whole-surface tone: `background: hsl(var(--tone)/0.10)`, ring `inset 0 0 0 var(--hl) hsl(var(--tone)/0.40)`, tone ink, and a leading status icon or dot. Or, on a neutral card, a tinted value + status pill/dot. | `--pos`, `--neg`, `--warn`, `--dv-iv` |
| Buy/sell or call/put side of a row | A text tag (`.side-tag` B/S, CE/PE) tinted with `--c-buy/--c-sell` or `--dv-call-ink/--dv-put-ink`. | |
| Calls/Puts table legends | Side-ink label text plus a 10px filled square swatch (the chart legend swatch). Header underline is the neutral separator only. | |
| Tick flash on a value | Ink fade + whole-value background flash (`dv-flash-up/down`), or a ▲/▼ glyph. No underline, no left bar. | |
| Stale panel/banner | Existing dim (0.7) + an amber status pill in the panel head ("Stale · 12s" with dot). | `--warn` |

### 1.2 Card edges

Every panel edge is drawn **once**, uniformly, on all four sides: `box-shadow: 0 0 0 var(--hl) var(--mat-separator)` (the desk mechanism, layout-neutral). No `border` plus ring, no `--spec-top` inset highlight on cards.

### 1.3 Separators

One mechanism everywhere: row rule = `box-shadow: inset 0 calc(-1 * var(--hl)) 0 var(--mat-hairline)` on `td/th` (desk) or `border-bottom: var(--hl) solid var(--mat-separator)` on non-desk generic tables. Inside `.desk-panel` and inside the merged API page the generic `th/td border-bottom` is reset to 0 and the inset rule is used, so each table on a page uses one weight.

### 1.4 Allowed one-sided fades

Only as overflow hints (`.scr-wrap.more-x`, `.scr-tabwrap.fade-r`, `.vol-legend-row`, `.desk-stats.vol-tiles`, `.arb-rail-row`, sidebar bottom mask), and only **while there is overflow on that side** (JS toggles `fade-l`/`fade-r`).

---

## 2. Elevation scale

One scale, five levels plus chrome. Each level has exactly one background, one edge, one shadow and one radius. New tokens go in the **first `:root {` block** of app.css (polish.test reads it); the dark values go in **both** dark blocks, identically.

| Level | Used by | Background (light / dark) | Edge | Shadow | Radius |
|---|---|---|---|---|---|
| L0 page | `body`, `#content` | `--background` | none | none | none |
| L1 panel | `.card`, `.desk-panel`, `.list`, `.arb-opp` | `--mat-grouped-solid` (no backdrop-filter) | `--edge-1: 0 0 0 var(--hl) var(--mat-separator)` | **none** | `--r-panel` |
| L2 inner surface | code blocks, quote tiles, `.cal-tile`, `.cal-kv-i`, `.rd-acct`, segmented tracks | `--mat-fill-1` | none (a hover may add a ring) | none | `--r-inner` |
| L3 popover | `.popover`, menus, Customise, vol menus, tooltips, readiness popover | `--surface-raised` | `--edge-1` | `--shadow-3` | `--r-pop` |
| L4 sheet / palette / modal | `dialog.sheet`, `dialog.palette`, `dialog.chain-sheet`, `#dialog` | `--surface-raised` (mat-thick + blur allowed) | `--edge-1` | `--shadow-float` | `--r-sheet` (phone bottom sheets: top corners only) |
| Chrome (floats over content) | sidebar, toolbar capsules, tab bar, toast, floating ATM pill | `--mat-glass*` | uniform rim `0 0 0 var(--hl) var(--mat-rim-b)` (no directional gradient) | `--shadow-2` (toast `--shadow-float`) | sidebar `--r-panel`; capsules, tab bar, toast `999px` |

Token values (new or changed):

| Token | Light | Dark |
|---|---|---|
| `--edge-1` **new** | `0 0 0 var(--hl) var(--mat-separator)` | same expression |
| `--shadow-1` | unchanged | `0 1px 2px hsl(0 0% 0% / 0.4)` (ring removed) |
| `--shadow-2` | unchanged | `0 10px 28px hsl(0 0% 0% / 0.5)` (ring removed) |
| `--shadow-3` | unchanged | `0 22px 56px hsl(0 0% 0% / 0.6)` (ring removed) |
| `--shadow-float` | unchanged | `0 36px 90px hsl(0 0% 0% / 0.7)` (ring removed) |
| `--panel-shadow` | `var(--edge-1)` | `var(--edge-1)` (was ring + shadow-1) |
| `--spec-top` | kept for glass chrome only, not used on cards or icon tiles | same |
| `--surface-raised` | exists per foundation.md; define if missing: `#FFFFFF` | `#16161A` |
| `--r-inner` **new** | 12px | |
| `--r-panel` | 20px (was 16 for desk, 28 for `.card`) | |
| `--r-pop` **new** | 16px | |
| `--r-sheet` **new** | 28px | |
| `--r-ctl` alias of `--r-sm` 12px | nav rows, `.sb-search`, `.palette-option`, inputs | |

Rules:
- Shadows mean "floats". Resting panels in either theme have no drop shadow.
- No card-in-card: a panel may hold L2 surfaces, never another L1. A tab panel inside a page is not a surface (no fill, no edge); its content sits directly in the page or in one panel.
- Icon tiles are flat: `background: hsl(var(--tint)); box-shadow: none` (radius scale 9/8/12 unchanged).
- Radii literals 10/11/14/22/26/30/34px in shell/overlay CSS are replaced by the tokens above.

## 3. Spacing scale

| Token | Value | Used by |
|---|---|---|
| `--page-gutter` | `clamp(16px, 3vw, 32px)` | `#content` inline padding, toolbar inline padding, page head |
| `--panel-gap` | 24px ≥720px, 16px <720px | `#content` gap, `.grid` gap, page-level `.stack`, card pages |
| `--panel-gap-dense` | 12px | desk layout pages (`:root[data-layout="desk"]`), keeps dense trading pages dense |
| `--card-pad` | unchanged `clamp(16px, 2.2vw, 24px)` | `.card-body`, card heads, notes inside cards |
| `--sp-x` | 16px (desk) | desk panel inline padding |
| `--panel-head-h` | 52px ≥720px, 48px <720px | min-height of `.panel-head`, `.card-head`, `.chain-head`, `.strat-head`, `.pos-head`, `.pos-hedge-head`, `.oi-head`, Risk head |
| `--ctl-h` | 40px | every toolbar capsule (title, demo, ready, clock, search, refresh, ctx items) |
| `--page-tabs-h` | 40px | the page tab strip (§5.2) |
| Stack inside a card body | 12px | `.card-body .stack` only |

Page header: one height everywhere it shows. Desktop: eyebrow (group) + h1 + one-line sub, margin-bottom 16px. Phone (<720px): no eyebrow, sub clamped to one line, margin-bottom 16px. On ≥1024px non-desk pages the toolbar title pill is hidden (the sidebar shows the location); desk pages show the glyph only (no label) at ≥1024px.

## 4. Z-index scale

Tokens in the first `:root`; every literal z-index ≥ 10 in app.css/palette.css is replaced by one of these. Values <10 inside a table (sticky cells/corners) stay local but must be < `--z-raised`.

| Token | Value | Who |
|---|---|---|
| `--z-sticky` | 2 | sticky `thead th`, sticky columns |
| `--z-sticky-corner` | 3 | sticky head ∩ sticky column |
| `--z-pinned` | 6 | pinned rows/cells inside a table |
| `--z-raised` | 20 | `.movable.dragging`, `.strat-bar` (sticky bottom bar), in-panel overlays |
| `--z-veil` | 40 | `.scroll-edge`, `.scroll-edge-b` |
| `--z-chrome` | 50 | `.toolbar` (was 45), `.sidebar`, `.tabbar`, `button.oi-atm-pill` |
| `--z-popover` | 60 | `.popover`, `.popover.floating`, `.popover.customise`, `.vol-menu-body`, `.vol-pop-float` |
| `--z-panel-max` | 70 | `.movable.panel-max` |
| `--z-toast` | 90 | `#toast` fallback |

Dialogs (`dialog.sheet`, palette, modal) use the top layer. The toast becomes `popover="manual"` and calls `hidePopover(); showPopover()` on each show, so it is always the newest top-layer entry and sits above an open sheet. Placement: ≥1024px top centre of the content column under the toolbar (`top: calc(var(--toolbar-h) + var(--safe-t) + 8px); left:` the content column's centre, `translateX(-50%); max-width: 380px`). Panel heads keep their actions at the right (Strategy Saved / Save / Place, desk panel head buttons), so the middle of that row holds only titles and figures. `placeToast()` (app.js) checks the visible controls under the toast; if any (a narrow desktop where a head fills its row) it moves to the bottom right (`[data-place="low"]`: `right: var(--page-gutter); bottom: calc(24px + var(--safe-b))`) when that covers fewer. Never top-right: there it covered the Strategy Saved / Place buttons and desk head actions for its 2.6s; <1024px bottom-centre above the tab bar **and** above any sticky bottom bar (`bottom: calc(var(--tabbar-h) + var(--bottom-extra, 0px) + 20px + var(--safe-b))`; pages with a sticky bottom bar set `--bottom-extra`).

Sticky table headers on card pages: `.card .table-wrap > table > thead th { position: sticky; top: calc(var(--toolbar-h) + var(--safe-t)); z-index: var(--z-sticky); background: var(--mat-grouped-solid) }`; `.card-body.flush` uses `overflow: clip` (not hidden) so sticky works. Sticky heads are opaque with one hairline, no gradient fade (chain, OI, arb, card tables all alike).

Bottom of the screen on <1024px: `.scroll-edge-b` ends at an opaque `hsl(var(--background))` and covers the bar's 12px offset plus `--safe-b`; `#content` gets `padding-bottom: calc(var(--tabbar-h) + 24px + var(--safe-b) + var(--bottom-extra, 0px))` so the last row scrolls clear.

---

## 5. The menu

### 5.1 Sidebar (13 items, from 20)

`PAGES` stays the one list (sidebar, tab bar, More, palette). Group order and items:

| Group | Item (label) | id | icon / tint | Notes |
|---|---|---|---|---|
| (no label) | Home | `home` | home / blue | |
| **Trade** | Option Chain | `chain` | chart / green | |
| | Strategy Builder | `strategy` | strategy / purple | |
| | Positions | `positions` | wallet / teal | moved from Options |
| | Orders | `orders` | orders / orange | title becomes "Orders" (positions live on Positions) |
| | Safety | `safety` | safety / red | |
| **Markets** | OI Analysis | `oi` | bars / orange | tabs: By strike, Participants |
| | Volatility | `vol` | wave / pink | |
| | Screeners | `screeners` | radar / yellow | tabs: Options, Arbitrage, Stocks |
| | Market calendar | `calendar` | calendar / teal | |
| **Bridge** | Accounts | `accounts` | accounts / indigo | |
| | API | `api` | keys / pink | tabs: Keys, Integrations, Test console, Rate limits, Activity |
| | Data recorder | `recorder` | clock / indigo | a Bridge service with settings |

Why these groups: Trade is the order of a trading workflow (look, build, hold, manage orders, guard) and sits above the fold at 1024x768. Markets is read-only market analysis and reference. Bridge is everything about this Bridge install (accounts, the developer API, the background recorder). At 1440x900 the whole nav fits with no scroll; at 1024x768 Trade and Markets fit.

Group label rows: `.nav-group` text, `--t-label`, `--a-quiet`, 16px above / 4px below; the first group (Home) has no label.

Shortcuts are **curated**, not the array index: a `key` field on PAGES. Ctrl/⌘ 1 Home, 2 Option Chain, 3 Strategy Builder, 4 Positions, 5 Orders, 6 Safety, 7 OI Analysis, 8 Screeners, 9 API. `pageShortcut()` takes the page (or its `key`) and `onGlobalKey` looks up by `key`.

Sidebar footer: `.sb-foot` (118px today) collapses to one 44px account row: status dot + key id + chevron. It opens a popover (L3) with Appearance (Light/Dark/Auto segmented), Keyboard shortcuts, About (font credit, moved from Home) and Forget key. `.sidebar-scroll` gets a bottom mask only while it overflows.

Desktop has one search: the sidebar `.sb-search` (Ctrl K hint). The toolbar search pill is hidden at ≥1024px; the phone/tablet keeps `.toolbar-search-m`.

### 5.2 Tabbed pages (one shell mechanism)

A PAGES entry may carry `tabs: [{ id, label, page, layout?, render, keywords, sub? }]` and `defaultTab`. `page` is the **legacy page id** of that view (`keys`, `integrations`, `console`, `limits`, `activity`, `screener`, `arb`, `scanner`, `oi`, `participants`). Routing:

- Hash form `#/<page>/<tab>?query`. `show()` parses `[pageId, tabId] = raw.split("?")[0].split("/")`.
- `LEGACY` map applied first in `show()` with `history.replaceState`, keeping `?query`:
  `console → api/console`, `limits → api/limits`, `keys → api/keys`, `integrations → api/integrations`, `activity → api/activity`, `screener → screeners/options`, `arb → screeners/arbitrage`, `scanner → screeners/stocks`, `participants → oi/participants`. Example `#/console?endpoint=order` → `#/api/console?endpoint=order`. `#/integrations?tab=python` → `#/api/integrations?tool=python` (Integrations accepts `tool` and still reads legacy `tab`).
- Unknown page ids still fall back to Home, but unknown **tab** ids fall back to the page's last tab (localStorage `mcb.tab.<page>`, try/catch) or `defaultTab`.
- `document.documentElement.dataset.page` is set to the **tab's legacy id** (so every existing `:root[data-page="oi|screener|strategy"]` rule and `app.js:481` ctx-mount check keep working); `dataset.route` holds the page id; `dataset.layout` comes from the tab (`tab.layout ?? page.layout`), so Screeners › Stocks is a card page and Options/Arbitrage are desk pages.
- The tab strip: `.page-tabs` (a `.segmented`, `role="tablist"`, uses `drawTabs()`), height `--page-tabs-h`, left-aligned, first row of `#content` (card pages: under the page head; desk pages: above the first panel), margin-bottom = the page's panel gap; horizontally scrollable with fades on phones. Switching a tab updates the hash (`#/api/limits`), re-renders only that tab, and the toolbar Refresh refreshes only the active tab. Old in-page tab strips that only repeat the page tab (the "Connect your tools" card head, the per-tab icon-tile card heads that restate the tab name) are removed.
- The sidebar, tab bar and More highlight the page (`api`) for any of its tabs. `document.title` = `"<Tab> · <Page> · Mr. Chartist API Bridge"`.
- All in-app links/`location.hash` writes to legacy ids keep working through LEGACY; the foundation still updates them to the new form (`#/participants` in participants.js, `#/screener` etc.).

### 5.3 The API page

`{ id: "api", label: "API", icon: "keys", tint: "pink", group: "Bridge", title: "API", sub: "Keys, integrations, a test console, rate limits and the request log" }`

| # | Tab | Hash | Renders | Inside |
|---|---|---|---|---|
| 1 | Keys (default) | `#/api/keys` | `renderKeys` | "Your keys" table + create form; `#key-label` focus target kept |
| 2 | Integrations | `#/api/integrations?tool=` | `renderIntegrations` | inner segmented (Webhooks, Python, Node, Excel and Sheets, AmiBroker, Claude (MCP), ChatGPT / OpenAI, REST / curl). Webhooks form rendered straight in the panel (no inner `.card`, no second icon tile); the code block is the only L2 surface; "No webhooks yet" sits in the webhook list area with `--card-pad` |
| 3 | Test console | `#/api/console?endpoint=` | `renderConsole` | code block `pre { white-space: pre; overflow-x: auto }` with Copy in a small header row above the code (never over it) |
| 4 | Rate limits | `#/api/limits` | `renderLimits` | page-level stack uses `--panel-gap`; empty cells via format.js placeholder |
| 5 | Activity | `#/api/activity` | `renderActivity` | inner segmented: Requests, Audit log; sticky table head |

Order follows setup: create a key, connect a tool, try a call, watch limits, audit. Default tab is Keys the first time, then the last tab used.

### 5.4 Other merges (and why)

- **Screeners** = Options (current Option Screener) + Arbitrage + Stocks (current Scanner). Three scanners in two groups confused users; the Option Screener's sub already promises arbitrage. Arbitrage keeps its desk layout as a tab (per-tab layout, §5.2); Stocks is a card-layout tab.
- **Live events** (added after this pass) is a fourth Screeners tab, `#/screeners/events` (legacy `#/events`), desk layout, between Arbitrage and Stocks. Why here: it answers the same question as the other screeners (which symbols deserve a look now), over the same universes, but pushed live instead of run on demand; a separate menu item would add a 14th row for a sibling of Stocks, and Trade is for acting, not finding. Ctrl K finds it as "Live events" (keywords: event selector, circuit, only buyers, volume surge).
- **OI Analysis** gets a Participants tab. Both are open interest; OI already links to Participants. Participant OI is desk layout like OI, so the shell is identical.
- **Market calendar** stays its own item in Markets (reference data with sources, linked from every contract notice). Not merged with Participants: different data and different readers.
- **Data recorder** moves to Bridge and is restyled as a desk page (desk panels, desk header) so it matches the data pages it feeds. Not tabbed into anything: it is a background service with settings.
- Rejected: a single "Market data" page with Calendar/Participants/Recorder tabs (auditor 3 alternative). The recorder is a setting, not market data, and Participants belongs with OI.

### 5.5 Phone / tablet tab bar and More sheet

- Tab bar (<1024px): **Home, Chain, Positions, Orders, More** (`tab: true` on home, chain, positions, orders). Safety stays one tap away through the toolbar readiness/kill pill, and is the first row of More.
- Active tab: the contrast pill holds the **icon only**, `padding: 4px 16px; margin: 0`; `.tab { gap: 2px }`; the label sits below the pill and never crosses its edge; selected label weight 600. Fits the 66-68px bar.
- More sheet: the same groups as the sidebar minus the four tab-bar pages, labels only (no `.sub` line), one row per page (API is one row; its tabs are in the palette), current row = fill-2 + trailing check (no stripe). Then Appearance, then "This browser" (Signed in, Forget key). "Keyboard shortcuts" row hidden under `(hover: none)`.
- All `:hover` fills on rows, nav items, table rows (`.list-row:hover`, `tbody tr:hover td`, `.nav a:hover`) move into `@media (hover: hover)` so a tap never leaves a second "selected" look.

### 5.6 Ctrl K palette

- Empty query: commands grouped under the sidebar group labels (Home, Trade, Markets, Bridge), then Actions.
- One command per tab, e.g. `{ label: "API keys", sub: "API › Keys", run: () => go("api/keys") }`, "Test console", "Rate limits", "Integrations", every Integrations tool ("Python snippet" → `api/integrations?tool=python`, "Webhooks"), "Audit log" (`api/activity?view=audit`), "Participant OI" (`oi/participants`), "Option Screener", "Arbitrage scanner", "Stock scanner". Legacy names are keywords (`console`, `limits`, `webhook`, `scanner`, `participants`).
- Ranking: exact/prefix > word-start > substring > in-order fuzzy; fuzzy hits need `score >= q.length * 3`, so "rate" ranks Rate limits first and not Strategy Builder.
- Shortcut hints from the curated `key` field. Actions updated: "Run a scan" → `screeners/stocks`, "Create API key" → `api/keys` `#key-label`, "Open test console" → `api/console`, "Place a paper order" → `api/console?endpoint=order` with sub "Send a paper order as JSON in the test console".

---

## 6. Toolbar

- Every capsule is 40px (`--ctl-h`): demo, ready, clock, ctx items, refresh, search, title.
- ≥1024px: no toolbar search, no page-name label on non-desk pages; desk pages show the same left item everywhere (glyph only); the account pill shrinks to its text.
- <720px on every desk page: Demo moves into the ⋯ (`ctx-more`) sheet, the spot % is dropped, the expiry is two lines with `min-width: max-content` (never "3 N"), the ctx sub-line is hidden on pages without an expiry (Market calendar shows "NIFTY" only). Pages that build their own toolbar (Screener) get `ctx-more` too.
- Rate state moves from the quiet banner into the ref-chip ("Rate 6.50 % default" + warn dot). `.ref-banner` is only for actionable info/warn/bad notices, and uses whole-surface tone (§1.1).

## 7. Placeholders

`chartSlot()` (app.js) returns `null` unless a chart engine is registered (`app.chartEngine`), and every caller filters nulls before `append/replaceChildren`. The dashed `.chart-slot-box` and placeholder panels ("Price chart · chart engine slot", OI timeline slot, chain-sheet chart slot, Participant OI slot, Vol/Arb/Screener slots) disappear until an engine exists. When shown, `.chart-slot-box` uses `--r-inner`, no dashed outline.

## 8. Numbers

All figures pass through format.js (house rule). Market snapshot tiles, Daily limits, Rate limits use grouped Indian formatting (`formatRupee`, `formatNumber`); empty cells use format.js's empty placeholder `DASH`, one en dash "–" (U+2013), drawn in the quiet ink inside a `table()` cell (never `--`).

---

## 9. Finding coverage

F = foundation task, A1/A2/A3 = area. "Rejected" entries give the reason.

**Shell audit.** nav leading bar → F; More list-row stripe → F; Home sec-eyebrow kicker → A3; acct-family-note top rule → A3; `--spec-top` on cards → F; icon-tile gradient + shadow → F; glass rim gradient → F; sticky touch hover → F; dark double edge → F; card drop shadows → F; Integrations card-in-card → F (API page); Safety readiness nesting + two separator systems → A3; z-index scale → F; non-sticky card table heads → F; tab bar pill over label → F; bottom veil see-through → F; Safety Daily limits clipped → A3; radii by level → F; panel gap tokens → F; form-grid align-items → F; Accounts capability chips → A3; Test console code under Copy → F; font licence on Home → F; page name ×3 / phone header height → F; toolbar 34/40 mix + double search → F; sidebar overflow + sb-foot → F; groups → F; API merge → F; Scanner/Screener/Arb merge → F (shell, routing) + A2 (screener/arb in tab) + A3 (Scanner in tab); Calendar/Participants/Recorder → F (menu) + A2 (Participants tab) + A3 (recorder restyle); tab bar + More → F; palette → F; Orders → A3 (**order sheet rejected for this pass**: it needs the chain ticket extracted from desk.js into a shared module, which crosses areas; Orders instead links "Trade from the chain" and "Send as JSON" in API › Test console, and drops its position tables); number formatting → A3.

**Desk audit.** nav bar → F; chain side-head underlines → A1; edge-ce/pe top bar → A1; em-edge → A1; stale chain-panel::before → A1; dv-mark underline/left bar → F; leg-row stripe → A1; strat-stale → A1; strat-adjust → A1; pnl spot row → A1; grid-table spot/tcol → A1; pk-row focus → A1; OI ladder ce/pe underlines → A2; OI selected row → A2; oi-wrow/mrow sel → A2; pos-table sel/focus → A1; pos-bulk → A1; pos-matrix spot → A1; chain focus row → A1; `--panel-shadow` double ring → F; Customise floating popover position → A1 (positioning in desk.js), F (z tier); toasts covering content → F; strat-bar stacking → A1; strat-grid half divider → A1; payoff ghost under text → A1; sheet nesting (cs-grid, warns, chart slot, ticket figs) → A1 (chart slot via F §7); chain header gradient fade → A1 (+ A2 for OI parity); bottom padding / ATM pill → F (padding) + A2 (pill into ladder head); panel head heights → F (token) + A1/A2 apply; two hairline systems in desk tables → F; toolbar ctx clipping/inconsistency → F; chain search placeholder → A1; be-list orphan dot → A1; hero-pop ring → A1; ticket form alignment → A1; oi-part phone wrap → A2; placeholder panels → F (§7) + A1 (Strategy chart panel, Hedge helper fold) + A2 (OI tslot); Options menu merge → F; tab bar pill/label → F. **Rejected:** merging the strat-bar into the tab bar as one surface (auditor alternative): it couples a page bar to the shell on one page; the solid-backed strat-bar under the tab bar is chosen instead.

**Data-pages audit.** vol-persona bar → A2; vol-term sel → A2; vol-surf sel → A2; vol-strikes hl → A2; vol gap row → A2; scr sel → A2; scr lead `--edge` → A2; scr-card edges → A2; scr focus three sides → A2; screener/arb sheet action bars → A2; scr-live under Demo on phone → A2 (+ F ctx-more rule); scr pin header → A2; arb-opp ::before → A2; arb-card ::before → A2; arb-table row bars → A2; arb pane inner scroll → A2; arb tablet rail → A2; ref-banner.info purple edge → F; cal-tile ring → A3; inner radii (calendar, chart-slot-box) → A3 + F (token, chart-slot-box); ban list half row → A3; calendar ctx sub clip → F; phone expiry clip/Demo → F; rec-feas mine row → A3; recorder `.card` system → A3 (+ F fixes `.card`); recorder header → A3; menu regroup → F; chart-slot boxes → F; quiet Rate banner → F; z-index → F; vol persona phone layout → A2; fades only while overflowing → A2 (vol/arb/screener rows).

---

## 10. Checks

- `npx vitest run server/bridge/dashboard` and `npm run -s check:mjs` green after every builder. `polish.test.mjs` (first `:root` tokens, identical dark blocks), `typeSystem.test.mjs`, `buttonSystem.test.mjs`, `format.test.mjs` file list.
- Foundation adds to `polish.test.mjs`: (a) no `inset Npx 0 0` / `inset 0 Npx 0` with N ≥ 1.5 in an accent, status or `--sel-bg` colour anywhere in app.css (allow-list: `--sel-ring` whole rings `inset 0 0 0`, separator hairlines `--hl`); (b) no `::before`/`::after` with `width|height: [1-4]px` and `left|right|top: 0` paired with a colour other than separator; (c) no literal `z-index` ≥ 10 outside the token block; (d) every PAGES `tabs[].page` and every LEGACY key resolves; (e) `--edge-1`, `--r-panel`, `--r-inner`, `--r-pop`, `--r-sheet`, `--panel-gap`, `--z-*` exist in the first `:root`.
- Screenshots at 1440x900, 820x1180, 390x844 (touch, DPR 2), light and dark, of every page and tab, under `scratchpad/ui3/<label>/`; read them before judging; delete raw PNGs and the mktemp demo home afterwards; kill the demo Bridge by PID.
- Old hashes `#/console?endpoint=order`, `#/keys`, `#/limits`, `#/integrations?tab=python`, `#/activity`, `#/scanner`, `#/screener`, `#/arb`, `#/participants` open the right tab (add these to `app.test.mjs` if routing is unit-testable, else to the screenshot script).

## 11. Ownership of shared files

- **app.css**: Foundation owns 0-12 (tokens, base, materials, shell incl. the desk top bar block, cards/lists, pills, tables, controls, 3b selection, 3c data viz/motion, code, bars, sign-in), 12b desk base (lines ~1713-1750), 12c movable, 12y options polish shared rules (popover.floating, chart-slot-box), 12r reference banners/chip (to the `── Market calendar page ──` marker), 13 responsive, 14 accessibility. Areas edit only their own sections; if an area needs a shared token it asks for it rather than adding a literal.
- **views.js**: Foundation owns PAGES, nav/tabbar/moreSheet, show/go/routing, the API page and the four render functions it hosts (renderKeys, renderIntegrations, renderConsole, renderLimits, renderActivity). Area 3 owns renderHome, renderAccounts, renderOrders, renderSafety, renderScanner. Areas 1 and 2 do not edit views.js.
- **app.js**: Foundation (chartSlot, toast, shell); Area 3 only `secEyebrow` and Home helpers. **palette.js / palette.css / index.html / reference.js / motion.js / core/app.mjs / format.test.mjs**: Foundation only.
