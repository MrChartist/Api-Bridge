# API Bridge brand spec: the Mr. Chartist family look

Status: spec only, 30 October 2026. Nothing in `server/bridge/dashboard/` was changed by this document. Section 6 lists the CSS changes in the order to apply them, sized for one commit.

Sources, measured with Playwright Chromium on 30 October 2026 (`getComputedStyle` on live elements, and the custom properties as the browser resolved them on `<html>`):

| Site | Pages read | Notes |
|---|---|---|
| mrchartist.com | `/` (home), `/fii-dii-data` (the closest page to a data terminal) | The parent brand. Asset tag `brand-v3`. Has a `.theme-bridge` product scope in its CSS already. |
| ipodecode.mrchartist.com | `/` (landing), `/today` and `/terminal` (the app shell) | The product our dashboard was ported from (see the header of `app.css`). |
| ipodecode.com | not reachable | The proxy answered 502 to CONNECT on every try (`ERR_TUNNEL_CONNECTION_FAILED`). It is the same product as ipodecode.mrchartist.com, so nothing is lost. optionsdesk.mrchartist.com was also tried and was also unreachable. |

Screenshots (session scratchpad, not committed; 1440 px and 390 px, dark and light, each theme switched with the site's own toggle):

```
/tmp/claude-0/-home-user-api-bridge/f0059dc2-aa37-55ea-b3a6-c17ba0d3d4a5/scratchpad/brand/mrchartist-1440-dark.png
/tmp/claude-0/-home-user-api-bridge/f0059dc2-aa37-55ea-b3a6-c17ba0d3d4a5/scratchpad/brand/mrchartist-1440-light.png
/tmp/claude-0/-home-user-api-bridge/f0059dc2-aa37-55ea-b3a6-c17ba0d3d4a5/scratchpad/brand/mrchartist-390-dark.png
/tmp/claude-0/-home-user-api-bridge/f0059dc2-aa37-55ea-b3a6-c17ba0d3d4a5/scratchpad/brand/mrchartist-390-light.png
/tmp/claude-0/-home-user-api-bridge/f0059dc2-aa37-55ea-b3a6-c17ba0d3d4a5/scratchpad/brand/mrchartist-fiidii-1440-dark.png
/tmp/claude-0/-home-user-api-bridge/f0059dc2-aa37-55ea-b3a6-c17ba0d3d4a5/scratchpad/brand/mrchartist-fiidii-1440-light.png
/tmp/claude-0/-home-user-api-bridge/f0059dc2-aa37-55ea-b3a6-c17ba0d3d4a5/scratchpad/brand/mrchartist-fiidii-390-dark.png
/tmp/claude-0/-home-user-api-bridge/f0059dc2-aa37-55ea-b3a6-c17ba0d3d4a5/scratchpad/brand/mrchartist-fiidii-390-light.png
/tmp/claude-0/-home-user-api-bridge/f0059dc2-aa37-55ea-b3a6-c17ba0d3d4a5/scratchpad/brand/ipodecode-1440-dark.png
/tmp/claude-0/-home-user-api-bridge/f0059dc2-aa37-55ea-b3a6-c17ba0d3d4a5/scratchpad/brand/ipodecode-1440-light.png
/tmp/claude-0/-home-user-api-bridge/f0059dc2-aa37-55ea-b3a6-c17ba0d3d4a5/scratchpad/brand/ipodecode-390-dark.png
/tmp/claude-0/-home-user-api-bridge/f0059dc2-aa37-55ea-b3a6-c17ba0d3d4a5/scratchpad/brand/ipodecode-390-light.png
/tmp/claude-0/-home-user-api-bridge/f0059dc2-aa37-55ea-b3a6-c17ba0d3d4a5/scratchpad/brand/ipodecode-today-1440-dark.png
/tmp/claude-0/-home-user-api-bridge/f0059dc2-aa37-55ea-b3a6-c17ba0d3d4a5/scratchpad/brand/ipodecode-today-1440-light.png
/tmp/claude-0/-home-user-api-bridge/f0059dc2-aa37-55ea-b3a6-c17ba0d3d4a5/scratchpad/brand/ipodecode-today-390-dark.png
/tmp/claude-0/-home-user-api-bridge/f0059dc2-aa37-55ea-b3a6-c17ba0d3d4a5/scratchpad/brand/ipodecode-today-390-light.png
/tmp/claude-0/-home-user-api-bridge/f0059dc2-aa37-55ea-b3a6-c17ba0d3d4a5/scratchpad/brand/ipodecode-terminal-1440-dark.png
/tmp/claude-0/-home-user-api-bridge/f0059dc2-aa37-55ea-b3a6-c17ba0d3d4a5/scratchpad/brand/ipodecode-terminal-1440-light.png
/tmp/claude-0/-home-user-api-bridge/f0059dc2-aa37-55ea-b3a6-c17ba0d3d4a5/scratchpad/brand/ipodecode-sidebar-dark.png
```

## 0. The short version

The dashboard is already most of the way there. It uses the same three typefaces (byte-for-byte the same families, our own subset), the same type scale (`docs/theme/TYPE-SYSTEM.md`), the same button system (ink and paper), the same lockup geometry as the IPO Decode sidebar, and the same motion curves as IPO Decode. What still separates it from the family is colour:

1. **Canvas and ink.** The parent brand is pure black on pure white and pure white on pure black. We draw #0A0A0B on #F4F4F5 and #F4F4F6 on #040404.
2. **Dark cards.** The family's dark cards sit at about 11 % lightness (#1C1C1E on mrchartist.com, #211E1C on IPO Decode). Ours are #0D0D0D, nearly the canvas.
3. **Gain and loss.** The family's green and red are #1F7F37 / #D70015 (light) and #64C775 / #ED756A (dark). Ours are iOS greens and reds.
4. **The wine accent.** The one italic serif word in a headline is wine (#9B255C light, #E66EA3 dark) on a clear pane. Ours draws the serif word in the text colour.
5. **The favicon.** Ours is filled #1A0B10 (an old wine-black), which disappears on a dark browser tab.

Fix those five and the dashboard reads as a Mr. Chartist product. Everything else in this document is either already right or belongs on a marketing page, not in a trading terminal.

## 1. What the Mr. Chartist brand is

### 1.1 Colour (resolved values)

The parent palette, from mrchartist.com (`:root, .light` and `.dark, .obsidian`, the last blocks in the cascade, which win):

| Role | Token on the site | Light | Dark |
|---|---|---|---|
| Canvas | `--bg`, `--background` | #FFFFFF | #000000 |
| Ink | `--fg`, `--foreground` | #000000 | #FFFFFF |
| Secondary ink (solid) | `--fg-2` | #58585C | #AEAEB2 |
| Card | `--card` | #FFFFFF (`0 0% 100%`) | #1C1C1E (`240 3% 11%`) |
| Muted fill, status label fill | `--muted`, `--brand-label-fill` | #F2F2F7 (`240 24% 96%`) | #2C2C2E (`240 2% 18%`) |
| Hairline / soft / control | `--hair`, `--hair-soft`, `--hair-control` | black at 0.14 / 0.10 / 0.20 | white at 0.13 / 0.09 / 0.18 |
| Brand accent (the serif word only) | `--wine` | #9B255C | #E66EA3 |
| Gain text | `--up` | #1F7F37 | #64C775 |
| Loss text | `--dn` | #D70015 | #ED756A |
| Gain fill | `--up-fill` | #22A34A | #50B863 |
| Loss fill | `--dn-fill` | #FF3B30 | #E46156 |
| Calls / puts (tokens defined, unused on the pages read) | `--call`, `--put` | #2154BE / #7A5D2E | #7AADFF / #E6D1A7 |
| Primary action | `--primary`, `--brand-ink` | black | white |
| Trade buttons | `--tr-buy`, `--tr-sell`, `--tr-ink` | `--up` / `--dn`, white label | `--up` / `--dn`, black label |
| Theme colour (browser chrome) | `<meta name="theme-color">` | #FFFFFF | #000000 |

On the FII and DII page the two institution series are blue and orange: FII #0972E1 light / #47A9FF dark, DII #EA7806 light / #FFAD33 dark (chips: the series colour at 12 % fill with a 30 % edge; header text in a darker ink, #0959AE and #914308 light). Net buying and selling figures use `--up` and `--dn`. Charts draw 2 to 2.5 px series lines, bars in the gain and loss colours, axes in `--fg-2`.

IPO Decode is the same system with a warm paper tint: canvas #F9F8F5 light / #0F0E0D dark, cards #FFFFFF / #211E1C, iOS system colours for icon tints and chart series (blue #007BFF, orange #FF9500, indigo #5755CE, purple #B054DE, teal #2EA9C2, green #33C758, red #FF382E in light), and one faint copper glow (`--wall-a: #E0865229`). Its toggles and buttons are the ink and paper pair, the same as ours.

### 1.2 Type

Three families, self-hosted, one job each, exactly as `docs/theme/TYPE-SYSTEM.md` says:

| Family | Loaded from (mrchartist.com) | Loaded from (IPO Decode) | Job seen on the pages |
|---|---|---|---|
| Chartist Sans (Plus Jakarta Sans, OFL) | `/fonts/chartist-sans/chartist-sans.woff2` | `/fonts/chartist-sans/chartist-sans-v1.woff2` | Headings at 600: hero 84 px / tracking −0.037em, section 68 px, app page title 38 px −0.02em, lockup name 17 px −0.03em |
| Chartist Sans Flex (Google Sans Flex, OFL) | `/fonts/chartist-sans-flex/chartist-sans-flex.woff2` plus `/fonts/inter/inter-symbols-var.woff2` for arrows and ticks | `...-v1.woff2` plus `chartist-sans-flex-symbols-v1.woff2` | Everything else: body 16 px 400 (380 in dark), nav 13.5 to 14 px 500 to 600, labels 12 px 500 to 600, table cells 12 to 14 px at 350, KPI figures 38 to 40 px |
| Chartist Serif (Instrument Serif, OFL) | `/fonts/chartist-serif/chartist-serif-italic.woff2` | `.../chartist-serif-italic-v1.woff2` | The one italic accent word per page, 1.04 × the headline size, wine |

Both sites resolve `--fw-num: 350`, `--fw-label: 500`, `--fw-title: 600`, `--fw-body: 400` (380 in dark), `--t-label: 500 12px/1.3`. Tables (FII and DII page): headers 12 px, cells 12 to 14 px at 350, all `tabular-nums`, right-aligned figures, 12 px × 16 px cell padding, 1 px row rule at the hairline alpha.

Our vendored fonts (`server/bridge/dashboard/fonts/`) are the same families with the same "Modified by Mr. Chartist (subset and renamed), 2026" description, cut to weight 300 to 600 (the site's cut goes to 800; ours caps at 600, which is what our tests require). The licence file and OFL texts are already in place. **No font files need to be added.**

### 1.3 Shape

| Thing | mrchartist.com | IPO Decode app | Dashboard today |
|---|---|---|---|
| Content card | 24 px radius, 24 to 28 px padding, 1 px hairline, no shadow in dark | 22 to 28 px | `--r-panel` 20 px (pinned by `polish.test.mjs`) |
| KPI tile | 16 px radius, 16 px padding | | 20 px |
| Inner tile, input | 12 px, inputs 10 px | 12 px | `--r-inner` 12 px |
| Chip | 6 px (`--radius-chip`), pills 999 px | 999 px | 999 px |
| Nav link, toolbar capsule | 999 px capsule, 44 px tall | 999 px capsule, 36 to 40 px | 999 px, `--ctl-h` 40 px |
| Button, large | 12 px radius, 52 px tall | 12 px (landing), 999 px (toolbar) | button system |
| Connected button group | 10 px outer corners, 0 inside, one 1 px edge | | button system §5 |
| Floating chrome | glass header capsule, inset 18 px × 40 px | glass sidebar 264 px, inset 14 px, radius 30 px | flush sidebar 216 px |

### 1.4 Buttons

Both sites use the pair our button system already encodes (`docs/theme/BUTTON-SYSTEM.md`):

- **Primary** = ink fill: white on dark (`rgb(255 255 255)` with black text), black on light. 14 to 15 px, weight 600, 1 px edge in the same colour.
- **Secondary** = paper fill: black on dark with a `rgb(255 255 255 / 0.18)` edge, white on light with a `rgb(0 0 0 / 0.20)` edge.
- **Quiet / icon**: no fill, 44 px square or 40 px circle, the icon at 72 % ink.
- Transitions: colour, border and shadow over 150 ms, transform over 400 ms on a spring. Nothing moves on hover.

### 1.5 Logo and wordmark

- The symbol is four nested ribbons (the same paths as our `#mc-symbol`). It is always one flat colour: black on light, white on dark (`currentColor`). Never a gradient, never wine.
- mrchartist.com navigation: the horizontal logo as an outlined SVG (`/branding/logo-horizontal-black.svg`, 716 × 210, drawn at 109 × 32), symbol left, "Mr. Chartist" right.
- IPO Decode sidebar: a 40 px symbol inside a 60 px box (10 px padding), 10 px gap, then the product name in Chartist Sans 17 px, weight 600, tracking −0.03em. Our lockup (`.lockup`, `app.css` line 714 onwards) is the same geometry, with a second line "by Mr. Chartist" at 12 px 500 in the quiet ink.
- Favicon, mrchartist.com: the symbol alone, `#000000` in light and `#FFFFFF` in dark, switched by `prefers-color-scheme` inside the SVG. IPO Decode: a white symbol on a #0D0D0D square.
- A faint, outlined copy of the symbol sits behind some pages (mrchartist.com `LogoBackdrop`, our `.app-symbol`).

### 1.6 Navigation and header patterns

- Parent site, desktop: one floating glass capsule; links 14 px, weight 600, at about 86 % ink, each a 44 px capsule; a connected group on the right (product link, search, theme); a separate "Sign in" capsule. Phone: a slim top capsule (logo, search, theme) and a floating five-item tab bar at the bottom with a contrast capsule for the current item.
- IPO Decode app: a floating glass sidebar; group labels "Live", "Research", "Archive" in 12 px 600 sentence case at 56 to 60 % ink; rows 36 px, 14 px, 500 (600 when current), each with a tinted 18 px line icon; a Light / Dark / Auto segmented control at the foot with a disclaimer line under it. Top toolbar: separate capsules for the page name, a "Delayed" status pill with an orange dot, an IST clock ("22:51:44 IST" in tabular figures), a search field with a ⌘K hint, then notification and share icons.

Our sidebar, toolbar, clock and demo pill already follow the IPO Decode pattern. Keep them.

### 1.7 Numbers and data

- Tabular figures everywhere, a true minus sign (−), the rupee sign tight to the number, a leading plus on gains: "+₹11271.73 Cr", "−₹10148.41 Cr".
- Gain and loss carry both colour and sign. On the FII and DII page the sign is always there.
- Big figures are large and light in the type system (`num-hero` 40 px at 350). The live site draws them at 700 to 800 (see section 5).

### 1.8 Motion (resolved values)

| Token | mrchartist.com | IPO Decode | Dashboard |
|---|---|---|---|
| Fast / fade | 150 ms (`--dur-fast`, `--fade-d`) | 140 ms | `--dur-1` 120 ms, `--dur-hover` 150 ms |
| Press | 120 ms | 140 ms | `--dur-press` 100 ms |
| Hover | 250 ms | 140 ms | 150 ms |
| Page / standard | 320 ms (`--dur-page`) | 260 ms | `--dur-3` 320 ms |
| Spring | 600 ms, `linear()` curve peaking at 1.146 | `cubic-bezier(.32, 1.28, .44, 1)` | `--ease-spring`, same as IPO Decode |
| Ease | `cubic-bezier(.2, .8, .2, 1)`, expo out `(.16, 1, .3, 1)` | `cubic-bezier(.22, 1, .36, 1)` | `--ease-out`, same as IPO Decode |

The dashboard matches IPO Decode exactly and is within one step of the parent. No motion change is needed.

### 1.9 Voice

Plain, specific, calm, and honest about limits. Headlines are short claims with one italic turn: "Read the market *before you trade it.*", "Every IPO. *Decoded.*", "FII and DII *money flows*". Copy names the person behind it ("One named analyst behind all of it, and every claim open to check") and carries its disclaimers in the open ("Educational information, not investment advice", "GMP is unofficial"). Sentence case on every label and button. `lang="en-IN"`, rupees, IST.

For the Bridge that means: say what is happening on this computer, say when data is demo or delayed, never hype.

## 2. Token mapping

Only tokens whose value changes are listed. Tokens not listed keep their current value. HSL triplets are what `app.css` stores; the hex is for review.

### 2.1 Light (`:root`)

| Token | Now | Brand value | Source |
|---|---|---|---|
| `--background` | `240 4.8% 95.9%` #F4F4F5 | `240 23.8% 95.9%` #F2F2F7 | mrchartist `--muted` / `--brand-label-fill`. Cards stay white and still separate from the canvas. |
| `--foreground` | `240 4.8% 4.1%` #0A0A0B | `0 0% 0%` #000000 | mrchartist `--fg` |
| `--sel-bg` | `240 4.8% 4.1%` | `0 0% 0%` | follows the ink (mrchartist `--control-selected-fill`) |
| `--wall-a` | `hsl(22 70% 60% / 0.16)` | `transparent` | the parent has no copper glow; it is an IPO Decode landing effect |
| `--pos` (fill) | `138 68% 38%` #1FA347 | `138.6 65.5% 38.6%` #22A34A | `--up-fill` |
| `--pos-ink` | `142 84.8% 25.9%` #0A7A33 | `135 60.8% 31%` #1F7F37 | `--up`, also TYPE-SYSTEM.md §6 |
| `--neg` (fill) | `3 75.6% 53.3%` #E2382E | `3.2 100% 59.4%` #FF3B30 | `--dn-fill` |
| `--neg-ink` | `3 75.5% 44.9%` #C9241C | `354.1 100% 42.2%` #D70015 | `--dn`, also TYPE-SYSTEM.md §6 |
| `--div-p3` | `142 84.8% 25.9%` | `135 60.8% 31%` | the strongest gain step is the gain ink |
| `--div-n3` | `3 75.5% 44.9%` | `354.1 100% 42.2%` | the strongest loss step is the loss ink |
| `--brand-wine` **new** | | `332 61.5% 37.6%` #9B255C | `--wine` |

`--btn-buy` and `--btn-sell` already point at `--pos-ink` and `--neg-ink`, so the buy and sell buttons follow.

### 2.2 Dark (both dark blocks, kept identical)

| Token | Now | Brand value | Source |
|---|---|---|---|
| `--background` | `0 0% 1.6%` #040404 | `0 0% 0%` #000000 | `--bg` (the test needs lightness ≤ 3 %: 0 passes) |
| `--foreground` | `240 10% 96.1%` #F4F4F6 | `0 0% 100%` #FFFFFF | `--fg` |
| `--card` | `0 0% 5.1%` #0D0D0D | `240 3.4% 11.4%` #1C1C1E | `--card` (and `.site-card` on the FII page) |
| `--mat-grouped-solid` | `hsl(0 0% 5.1%)` | `hsl(240 3.4% 11.4%)` | = card |
| `--mat-grouped` | `hsl(0 0% 5.1% / 0.94)` | `hsl(240 3.4% 11.4% / 0.94)` | the site's `rgba(28, 28, 30, 0.96)` card |
| `--mat-grouped-hover` | `hsl(240 7% 8% / 0.96)` | `hsl(240 2.6% 14.9% / 0.96)` #252527 | one step above card |
| `--surface-raised` | `240 8.3% 9.4%` #16161A | `240 2.2% 17.6%` #2C2C2E | `--muted` (popovers must sit above a #1C1C1E card) |
| `--mat-thick` | `hsl(240 7% 9% / 0.96)` | `hsl(240 3% 13% / 0.96)` | sheets and palette above cards |
| `--mat-glass` | `hsl(240 6% 8% / 0.62)` | `hsl(240 3% 11% / 0.62)` | neutral grey, no blue cast |
| `--mat-glass-strong` | `hsl(240 6% 6% / 0.80)` | `hsl(240 3% 9% / 0.80)` | sidebar |
| `--pos` (fill) | `135 63.6% 50.4%` #30D158 | `131 42.3% 51.8%` #50B863 | `--up-fill` |
| `--pos-ink` | `135 63.6% 50.4%` #30D158 | `130.3 46.9% 58.6%` #64C775 | `--up` / `--profit` |
| `--neg` (fill) | `3 100% 65.7%` #FF5A50 | `4.6 72.4% 61.6%` #E46156 | `--dn-fill` |
| `--neg-ink` | `3 100% 65.7%` #FF5A50 | `5 78.4% 67.3%` #ED756A | `--dn` / `--loss` |
| `--div-p3` | `135 63.6% 50.4%` | `130.3 46.9% 58.6%` | = gain ink |
| `--div-n3` | `3 100% 65.7%` | `5 78.4% 67.3%` | = loss ink |
| `--brand-wine` **new** | | `333.5 70.6% 66.7%` #E66EA3 | `--wine` |

Unchanged on purpose: `--a-label` 0.70 and `--a-quiet` 0.60 / 0.54 (they already beat the brand's solid `--fg-2`, see 2.3), `--mat-separator` (0.10 / 0.11 sits inside the brand's 0.09 to 0.14 range), the call and put colours (section 2.4), IV violet, `--warn`, the radius scale, the motion tokens, the button tokens, and every `--ios-*` icon tint.

### 2.3 Contrast check (WCAG 2.x, measured)

Computed from the hex values above (sRGB relative luminance). AA needs 4.5:1 for text and 3:1 for chart marks and fills.

**Light, proposed** (canvas #F2F2F7, card #FFFFFF):

| Colour | Hex | On card | On canvas | Passes |
|---|---|---|---|---|
| Ink | #000000 | 21.0 | 18.8 | text |
| Label ink (fg at 0.70) | #4D4D4D | 8.45 | 7.58 | text |
| Quiet ink (fg at 0.60, the floor) | #666666 | 5.74 | 5.15 | text |
| Gain ink | #1F7F37 | 5.06 | 4.54 | text |
| Loss ink | #D70015 | 5.38 | 4.83 | text |
| Call ink (unchanged) | #0A62C9 | 5.83 | 5.22 | text |
| Put ink (unchanged) | #A65300 | 5.44 | 4.88 | text |
| Warn ink (unchanged) | #8A5A00 | 5.93 | 5.31 | text |
| IV ink (unchanged) | #6E35D6 | 6.68 | 5.99 | text |
| Wine | #9B255C | 7.47 | 6.69 | text |
| Gain fill | #22A34A | 3.28 | | marks |
| Loss fill | #FF3B30 | 3.55 | | marks |
| White label on gain ink (Buy) | | 5.06 | | text |
| White label on loss ink (Sell) | | 5.38 | | text |

Gain ink on the canvas is 4.54: it passes, but only just, so figures keep sitting on cards (they already do).

**Dark, proposed** (canvas #000000, card #1C1C1E, raised #2C2C2E):

| Colour | Hex | On card | On canvas | On raised | Passes |
|---|---|---|---|---|---|
| Ink | #FFFFFF | 17.0 | 21.0 | 13.9 | text |
| Label ink (fg at 0.70) | #BBBBBC | 8.87 | 10.95 | 7.27 | text |
| Quiet ink (fg at 0.54, the floor) | #979798 | 5.83 | 7.20 | 4.78 | text |
| Gain ink | #64C775 | 8.08 | 9.97 | 6.62 | text |
| Loss ink | #ED756A | 5.96 | 7.35 | 4.88 | text |
| Call ink (unchanged) | #4AA8FF | 6.75 | 8.34 | 5.53 | text |
| Put ink (unchanged) | #FF9F2E | 8.31 | 10.25 | 6.80 | text |
| Warn ink (unchanged) | #FFD60A | 12.05 | 14.88 | 9.87 | text |
| IV ink (unchanged) | #BF8CFF | 6.81 | 8.41 | 5.58 | text |
| Wine | #E66EA3 | 5.77 | 7.12 | 4.73 | text |
| Gain fill | #50B863 | 6.79 | | | marks |
| Loss fill | #E46156 | 4.98 | | | marks |
| Black label on gain fill (Buy) | | 8.38 | | | text |
| Black label on loss fill (Sell) | | 6.14 | | | text |

The selection pair stays 21:1 in both themes (black and white).

**Are green and red still told apart?** Measured as CIE76 ΔE between the gain and loss colours, plain and under full-strength colour-blind simulation (Machado 2009, severity 1.0):

| Pair | Normal | Deuteranopia | Protanopia | Luminance ratio |
|---|---|---|---|---|
| Light inks now (#0A7A33 / #C9241C) | 108 | 25.0 | 12.8 | 1.02 |
| Light inks proposed (#1F7F37 / #D70015) | 116 | 29.1 | 15.0 | 1.06 |
| Dark inks now (#30D158 / #FF5A50) | 128 | 7.2 | 40.2 | 1.52 |
| Dark inks proposed (#64C775 / #ED756A) | 92 | 5.9 | 27.1 | 1.36 |
| Dark, TYPE-SYSTEM.md values (#30D158 / #FF6961) | 123 | 5.3 | 42.2 | 1.40 |

Light improves. Dark is as weak for deuteranopes as it is today, with every candidate: any green and red pair bright enough for 4.5:1 on a dark card collapses to two similar olives. So colour must never be the only cue for direction, which the dashboard already guarantees and must keep guaranteeing:

- every signed figure carries "+" or "−" (`format.js`, enforced by `format.test.mjs`);
- bars and areas are split by a zero line (`--dv-zero`), so position says the sign;
- OI decreases are hatched (`#dv-hatch-*`);
- Buy and Sell buttons carry the word.

Note the brand's two sources disagree on dark gain and loss: TYPE-SYSTEM.md §6 lists #30D158 / #FF6961, the live mrchartist.com resolves #64C775 / #ED756A. This spec follows the live site, because the goal is to look like the live family. If the owner prefers the document, swap the four dark P&L values for `135 63.6% 50.4%` (#30D158, both fill and ink) and `3 100% 69%` (#FF6961); the contrast table above has both.

**Strong inks for tinted chips (light only).** The gain and loss inks clear 4.5:1 on the card and only just on the
canvas, so small text on an 8 to 16 % tint of its own colour fell to 4.0 to 4.47:1 (measured 30 Oct, perf/a11y round 4).
Those chips use a darker step of the same hue in light; dark maps each token back to the ink it used, so dark is
unchanged and nothing else (figures, canvas text) uses them.

| Token (`app.css`) | Light | Dark | Used by |
|---|---|---|---|
| `--gain-ink-strong` | `135 60.8% 25%` | `var(--pos-ink)` | `.ev-chip.bull`, `.obu-LB`, `.obu-SC`, `.oi-tone-pill[data-tone="up"]`, `.scr-pill.t-pos`, `.bk-rel[data-tone="ok"]`, chain `.bu-LB` |
| `--loss-ink-strong` | `354 100% 36%` | `var(--neg-ink)` | `.ev-chip.bear`, `.obu-SB`, `.obu-LU`, `.oi-tone-pill[data-tone="down"]`, `.scr-pill.t-neg`, chain `.held.short`, chain `.bu-SB` |
| `--ok-ink-strong` / `--bad-ink-strong` | `137 64% 23%` / `356 78% 35%` | `var(--ios-green-ink)` / `var(--ios-red-ink)` | `.an-page .pill.sm.ok` / `.bad` |
| `--info-ink-strong` / `--warn-ink-strong` | `211 100% 33%` / `26 100% 28%` | `var(--ios-blue-ink)` / `var(--ios-orange-ink)` | `.an-page .pill.sm.info` / `.warn` |

All of them measure 4.5:1 or more on their tint over the light canvas and card. Out-of-month calendar days stay quiet
by design.

### 2.4 Chart colours

Keep the current data-viz system (`docs/design/foundation.md` §4): calls blue, puts orange, spot in the ink colour, IV violet, red and green only for money and direction. It already matches the family's own convention on the FII and DII page (institution series in blue and orange, net flows in green and red, axes in the secondary ink, 2 to 2.5 px lines). Do not adopt mrchartist.com's `--call` / `--put` tokens (#2154BE / #7A5D2E light, #7AADFF / #E6D1A7 dark): no page we read draws with them, the tan put sits close in hue to the amber `--warn`, and blue and orange is the pair the family actually shows (the FII and DII series) and the pair `foundation.md` §4 already tested.

## 3. Logo and wordmark in the dashboard

### 3.1 Sidebar header

Keep the current lockup (`index.html`, `a.sb-brand.lockup`): it is the IPO Decode lockup to the pixel.

- Symbol: `#mc-symbol` at 40 px with 4 px padding, `fill: hsl(var(--foreground))`. After section 2 this is pure black or pure white, exactly as the brand draws it.
- Name: "API Bridge", Chartist Sans 600 17 px, tracking −0.03em (`.lockup-name`).
- Endorsement: "by Mr. Chartist", 12 px 500 in `--a-quiet` (`.lockup-sub`). The product name leads and the parent endorses it underneath.
- Rail (56 px): symbol only, centred, no text.
- Never colour the symbol (no wine, no blue), never put it on a tile in the sidebar, never draw the outlined horizontal "Mr. Chartist" logo here (the product name leads, the parent endorses).

### 3.2 Login screen

- Keep the lockup at the top of the card, same as the sidebar.
- Give the `h1` its one accent word, the family's signature: `Sign in with your <em class="serif">admin key</em>`. Chartist Serif italic 400, wine, on the quiet pane in step 4 of section 6. One per page: the login screen and the Home headline ("Your *Bridge*") are the only two places.
- The faint outlined symbol behind the page (`.app-symbol`) stays: it is the family's `LogoBackdrop`.

### 3.3 Favicon

Replace `server/bridge/dashboard/logo.svg`'s fixed `fill="#1a0b10"` (the old ink-wine, invisible on a dark tab bar) with the IPO Decode treatment: a white symbol on a black square. It reads on light and dark tabs and needs no CSS.

```svg
<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024"><title>Mr. Chartist</title>
  <rect width="1024" height="1024" rx="224" fill="#000000"/>
  <g fill="#FFFFFF" transform="translate(512.0,512.0) scale(0.8) translate(-598.05,-627)"><!-- the four existing paths --></g>
</svg>
```

Why not the parent's adaptive favicon (a `<style>` with `prefers-color-scheme` inside the SVG): the Bridge serves `logo.svg` with `Content-Security-Policy: style-src 'self'` (`core/app.mjs` line 291), which blocks an inline `<style>` if a browser ever renders the file as a document. The tile needs no style at all.

Also add `<meta name="theme-color" media="(prefers-color-scheme: light)" content="#F2F2F7">` and `<meta name="theme-color" media="(prefers-color-scheme: dark)" content="#000000">` to `index.html`, as mrchartist.com does, so phone browser chrome matches the canvas.

## 4. Constraints this spec respects

Checked against `typeSystem.test.mjs`, `buttonSystem.test.mjs`, `polish.test.mjs`, `format.test.mjs` and `brokerLogos.test.mjs`:

- **Type ≥ 12 px, weight ≤ 600.** No new size or weight is introduced. The live sites' 650 to 800 weights are not copied.
- **No em dash** in visible text. The serif accent and favicon changes add none.
- **Button system.** No new button colour. Buy and sell follow `--pos-ink` / `--neg-ink` (light) and `--pos` / `--neg` (dark) through the existing `--btn-buy` / `--btn-sell`. The wine colour never appears on a button.
- **No decorative strips.** The serif pane is an all-round hairline, not a one-sided edge.
- **One panel radius** (`--r-panel: 20px`, pinned by the test). The family's 24 px card radius is not adopted.
- **Dark canvas lightness ≤ 3 %** and `--wall-a: transparent` in dark: 0 % passes.
- **Every colour token in all three blocks, the two dark blocks identical.** Step 3 edits both dark blocks the same way; `--brand-wine` goes into all three.
- **Self-only CSP.** Fonts are already self-hosted under `fonts/` with their OFL texts; nothing new is loaded from another origin. The favicon has no inline style.
- **Number format.** No grouping commas, true minus, tabular figures. The live sites print "₹11,271.73 Cr" with commas; we do not.

## 5. What not to copy

These are right for a marketing page and wrong for a dense trading terminal:

- **Hero headlines.** 64 to 96 px Chartist Sans, the painted sky and mountain backgrounds, star fields, light rays, the scrolling ribbon illustrations. The dashboard's largest text stays the page title and `num-hero`.
- **The glass pane at hero scale.** The serif word sits on a heavy pane with rim gradients, inner glow and a drop shadow (`--acc-rim`, `--acc-shade`, `--acc-drop`). We take only a hairline pane.
- **Gradient sheens on buttons** (`--btn-sheen`, `--pr-sheen`, `--gl-spec-*`, specular rims). Our buttons are flat ink and paper by test.
- **Heavy figures.** The FII page draws KPI numbers at 700 to 800 and table headers at 600. Our figures stay at 350 (TYPE-SYSTEM.md §3) and table headers at 400.
- **Grouping commas** in money ("₹11,271.73 Cr"). TYPE-SYSTEM.md §4 and `format.test.mjs` forbid them.
- **Em dashes in copy** (IPO Decode's page titles and link lists use the long dash between a name and its detail). Forbidden here.
- **Uppercase tracked micro-labels** ("WRITTEN BY", "01 · LEARN" at 0.02em and up). Labels stay sentence case.
- **The copper wallpaper glow** and the IPO Decode warm paper tint. The parent is neutral, and a trading screen should not tint prices.
- **The floating inset sidebar with a 30 px radius** and the floating header capsule. `docs/design/ui-pass-3.md` chose a flush sidebar to give the data room; keep it.
- **Blue-tinted current nav row** (IPO Decode). Our tests require the contrast state or a neutral fill.
- **Per-product accent theming** (`.theme-bridge`, `--product`). On mrchartist.com the Bridge's product accent resolves to the neutral brand grey, so there is nothing to bring over.
- **Cookie banner, "Ask anything" chat bubble, share buttons, social links.** Not part of a local tool.

## 6. CSS changes, in order (one commit)

Apply after the page redesign in progress has landed, then run `npx vitest run server/bridge/dashboard`.

1. **Light canvas and ink** (`app.css`, first `:root`):
   ```css
   --background: 240 23.8% 95.9%;
   --foreground: 0 0% 0%;
   --sel-bg: 0 0% 0%;
   --wall-a: transparent;
   ```
   Update the `body::before` comment ("one soft copper glow, as on the main website") to say the wallpaper is off in both themes, and the header comment's "(#050506) / neutral paper (#F4F4F5)" to "(#000000) / neutral paper (#F2F2F7)".

2. **Light gain and loss** (same block):
   ```css
   --pos: 138.6 65.5% 38.6%;
   --pos-ink: 135 60.8% 31%;
   --neg: 3.2 100% 59.4%;
   --neg-ink: 354.1 100% 42.2%;
   --div-p3: 135 60.8% 31%;
   --div-n3: 354.1 100% 42.2%;
   ```

3. **Dark surfaces, ink, gain and loss**, identically in `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) }` and `:root[data-theme="dark"]`:
   ```css
   --background: 0 0% 0%;
   --foreground: 0 0% 100%;
   --card: 240 3.4% 11.4%;
   --mat-grouped: hsl(240 3.4% 11.4% / 0.94);
   --mat-grouped-solid: hsl(240 3.4% 11.4%);
   --mat-grouped-hover: hsl(240 2.6% 14.9% / 0.96);
   --mat-glass: hsl(240 3% 11% / 0.62);
   --mat-glass-strong: hsl(240 3% 9% / 0.80);
   --mat-thick: hsl(240 3% 13% / 0.96);
   --surface-raised: 240 2.2% 17.6%;
   --pos: 131 42.3% 51.8%;
   --pos-ink: 130.3 46.9% 58.6%;
   --neg: 4.6 72.4% 61.6%;
   --neg-ink: 5 78.4% 67.3%;
   --div-p3: 130.3 46.9% 58.6%;
   --div-n3: 5 78.4% 67.3%;
   ```
   Update the "cards #0D0D0F, raised #16161A" comments to "#1C1C1E, raised #2C2C2E".

4. **The wine accent.** Add `--brand-wine: 332 61.5% 37.6%;` to the light `:root` and `--brand-wine: 333.5 70.6% 66.7%;` to both dark blocks. Then extend the existing rule at `app.css` line 1023:
   ```css
   .serif {
     font: italic 400 1.08em/1 var(--font-serif-accent);
     letter-spacing: -0.01em;
     color: hsl(var(--brand-wine));
     padding: 0 0.16em 0.04em;
     border-radius: 0.22em;
     background: var(--mat-fill-1);
     box-shadow: inset 0 0 0 var(--hl) var(--mat-separator);
   }
   ```
   Wine is for this one word only: never a link, button, nav item, chart series or status.

5. **Login accent word** (`index.html`): `<h1>Sign in with your <em class="serif">admin key</em></h1>`.

6. **Favicon and browser chrome**: rewrite `logo.svg` as in section 3.3 (black rounded square, white symbol) and add the two `theme-color` meta tags to `index.html`.

7. **Keep the docs and test mirrors honest** in the same commit:
   - `docs/design/foundation.md` §3.1 (surfaces: #F2F2F7 / #000000 canvas, #1C1C1E card, #2C2C2E raised), §3.2 (ink #000000 / #FFFFFF and the contrast figures in section 2.3), §3.3 (`--sel-bg` #000000), §4.1 (the `--pos` / `--neg` rows).
   - `polish.test.mjs`, "Foundation §4: contrast of the data-viz colours": `T.light.fg` `#000000`, `T.light.ink.pos` `#1F7F37`, `T.light.ink.neg` `#D70015`, `T.light.fill.pos` `#22A34A`, `T.light.fill.neg` `#FF3B30`, `T.light.sel[0]` `#000000`; `T.dark.card` `#1C1C1E`, `T.dark.fg` `#FFFFFF`, `T.dark.ink.pos` `#64C775`, `T.dark.ink.neg` `#ED756A`, `T.dark.fill.pos` `#50B863`, `T.dark.fill.neg` `#E46156`. In the step pairs: light div first `["#D70015", "#FFFFFF"]` and last `["#1F7F37", "#FFFFFF"]`; dark div first `["#ED756A", "#000000"]` and last `["#64C775", "#000000"]`. All of these pass with the values in section 2.3.

8. **Look, then check two things by eye** in dark at 1440 and 390: the first violet heat step (`--seq-1` #1E1631) and the IV band (`--dv-band` #1E192B) now sit on a #1C1C1E card and are close to it. Both measure about 1.02:1 against the new card. If a heat map's lowest bucket or the ±1σ band vanishes, lift `--seq-1` to `258 38% 18%` (#271C3F, white text 15.9:1) and `--dv-band` to `257 26.5% 17%` (#262037) in both dark blocks, and update the `polish.test.mjs` step pair for `--seq-1`.

Nothing else changes: no font files (they are already vendored and licence-clean), no radius, no motion, no layout.
