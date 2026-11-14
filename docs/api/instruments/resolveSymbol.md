# Resolve a name to one instrument, with the reason

`GET /v1/symbols/resolve`

| | |
|---|---|
| Area | [Instruments](../README.md#instruments) |
| Operation | `resolveSymbol` |
| Scope | `read` |
| This computer only | no |
| Guide | [quickstart.md](../../guides/quickstart.md) |

- An API key with the `read` scope (any key).

Reads what chart tools, spreadsheets and alerts write (`NSE:M_M`, `NSE_INDEX:NIFTY 50`, `NSE:RELIANCE-EQ`, `Reliance`)
and answers the one instrument it means, how it got there (`rule`, `rules`) and the ranked candidates. It never
guesses: a bare name carried by two instruments (RELIANCE on NSE and on BSE) is `AMBIGUOUS_SYMBOL` (409) with the
candidates in `candidates`; send `exchange` or the full symbol. A name that matches nothing exactly is
`SYMBOL_NOT_FOUND` (404) with the closest names in `candidates`. A bare name resolves to the cash or index
instrument; a future or option needs its full symbol.

## Parameters

| Name | In | Type | Required | Notes |
|---|---|---|---|---|
| `q` | query | string, up to 64 characters | yes | The symbol or name. `input` is accepted as the same parameter. |
| `exchange` | query | `Exchange` | no | Narrows a bare name to one exchange. |
| `kind` | query | `InstrumentKind` | no |  |
| `explain` | query | one of `0`, `1`, `true`, `false` | no | `1` or `true` adds `steps`, the reading in plain sentences. |
| `limit` | query | integer, min 1, max 50 | no | Candidates to return (default 10). |

## Responses

| Status | Meaning | Body |
|---|---|---|
| 200 | One instrument. | application/json: object |
| 4XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |
| 5XX | Error (RFC 9457 problem details). | application/problem+json: `Problem` |

### Fields of the 200 answer

| Field | Type | Required | Notes |
|---|---|---|---|
| `data` | `SymbolResolution` | yes |  |
| `meta` | `Meta` | yes |  |

#### Fields of `data` (`SymbolResolution`)

| Field | Type | Required | Notes |
|---|---|---|---|
| `input` | string | yes |  |
| `symbol` | `Symbol` | yes | Canonical Bridge symbol (see the introduction). Inputs may use accepted aliases. |
| `instrument` | `Instrument` | yes |  |
| `confidence` | one of `exact`, `unique-name` | yes | `exact`: a symbol form the Bridge reads. `unique-name`: exactly one instrument carries the name. |
| `rule` | string | yes | How the answer was reached |
| `rules` | array of string | yes | Each spelling that was rewritten (an exchange word, a chart name, a series suffix). |
| `candidates` | array of `SymbolCandidate` | yes |  |
| `steps` | array of string | no | With explain=1: the reading, step by step. |

## Errors

Errors are `application/problem+json` with a stable `code` and a `retryable` flag. Read the code, not the text. All codes: [errors.md](../errors.md).

| Code | HTTP | Retryable |
|---|---|---|
| `VALIDATION_FAILED` | 400 | no |
| `UNAUTHENTICATED` | 401 | no |
| `SESSION_EXPIRED` | 422 | no |
| `RATE_LIMITED` | 429 | yes |
| `UPSTREAM_RATE_LIMITED` | 429 | yes |
| `UPSTREAM_ERROR` | 502 | no |
| `BROKER_UNAVAILABLE` | 503 | yes |
| `UPSTREAM_TIMEOUT` | 504 | yes |

## Examples

curl (set `MCB_API_KEY` to your key first):

```bash
curl -s "http://127.0.0.1:4300/v1/symbols/resolve?q=RELIANCE" \
  -H "Authorization: Bearer $MCB_API_KEY"
```

Python (the SDK in sdk/python, see [python.md](../../guides/python.md)):

```python
from mrchartist_bridge import BridgeClient

bridge = BridgeClient()  # reads MCB_API_KEY and MCB_BRIDGE_URL from the environment

response = bridge.request("GET", "/v1/symbols/resolve", query={"q": "RELIANCE"})
print(response.body)
```
