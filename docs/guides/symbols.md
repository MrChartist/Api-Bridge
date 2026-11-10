# Symbols

Every instrument has one name in the Bridge, whichever broker is behind it. This page says how it is written, how to find a
symbol you only half know, and why a derivative stops working on its expiry day.

## The format

`EXCHANGE:UNDERLYING`, and for a derivative `EXCHANGE:UNDERLYING-YYYY-MM-DD` followed by what kind it is:

| Instrument | Written as |
|---|---|
| Share | `NSE:RELIANCE`, `NSE:BAJAJ-AUTO`, `NSE:M&M` |
| Index | `NSE:NIFTY`, `BSE:SENSEX` |
| Future | `NFO:NIFTY-<expiry>-FUT` |
| Option | `NFO:NIFTY-<expiry>-<strike>-CE` or `-PE` |

`<expiry>` is a date such as `2026-12-29`; the dates are left out of the table on purpose, because a contract that has
expired is not found (`SYMBOL_NOT_FOUND`) and an example with a date in it stops working on that day. Exchange codes are
`NSE` and `BSE` (shares and indices), `NFO` and `BFO` (equity derivatives), `MCX` and `CDS`. A strike can have a decimal point
(`292.5`). The Bridge reads the symbol from the right, so a hyphen in a name (`BAJAJ-AUTO`) is safe.

Answers always use this form. Inputs are more forgiving: case, chart-tool names such as `NSE:M_M`, a broker's own trading
symbol (`RELIANCE-EQ`) with an exchange, and chart tickers such as `NSE:NIFTY1!` are all understood, and an order
answer lists in `meta.normalised` anything that was rewritten.

## Find or convert a symbol

| You have | Ask | Answer |
|---|---|---|
| A name or part of one | `GET /v1/instruments/search?q=RELI&limit=5` | the matching instruments, with lot size and tick size |
| A symbol in another tool's spelling | `GET /v1/symbols/convert?input=NSE:M_M` | the canonical symbol (`NSE:M&M`) and the other spellings |
| A bare name such as `Reliance` | `GET /v1/symbols/resolve?q=Reliance` | the one instrument it means, the rule used, and the candidates |
| An underlying and you want the live expiries | `GET /v1/expiries?underlying=NIFTY` | the expiry dates that can be traded now |
| One symbol's details | `GET /v1/instruments/{symbol}` | lot size, tick size, freeze quantity, expiry, strike |

`resolve` never guesses. A bare name carried by two instruments (the same share on NSE and on BSE) is `AMBIGUOUS_SYMBOL` (409) with
the candidates in the answer: send `exchange=NSE` or the full symbol. A name that matches nothing exactly is `SYMBOL_NOT_FOUND`
(404) with the closest names. A bare name only ever resolves to a share or an index, never to a future or an option: send the
full symbol for those.

## Expiries and strikes

- Ask `GET /v1/expiries?underlying=NIFTY` before you build a derivative symbol, and take the date from the answer. Weekly and
  monthly expiries move around holidays, so do not calculate them.
- Collections and option universes do this for you ([collections.md](collections.md)): "NIFTY, current weekly, ATM plus or minus
  10" is resolved each time it is used, so the expiry rolls and the at-the-money strike moves with the price.
- Orders on derivatives are counted in lots (`lots`) or units (`quantity`); the lot size is in the instrument's details.

## When a symbol is refused

`SYMBOL_NOT_FOUND` on a share is usually a typo or the wrong exchange; on a derivative it is usually an expired date. The
[troubleshooting page](troubleshooting.md#symbol_not_found-404-or-an-entry-in-errors) has the example answers. Lists such as
`GET /v1/ltp?symbols=A,B` answer 200 with the symbols that worked in `data` and the ones that did not in `errors`.
