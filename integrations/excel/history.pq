// Mr. Chartist API Bridge — candles for one symbol (Power Query M).
// Needs a one-cell named range "BridgeKey" holding a Bridge read key. The key is sent as a header, not in the URL.
// Read-only: /xl/history cannot place orders.
let
    BridgeUrl = "http://127.0.0.1:4300",
    Symbol = "NSE:NIFTY",
    Interval = "5m",            // 1m, 3m, 5m, 10m, 15m, 30m, 60m, 1d, 1w or 1M
    Countback = "500",          // bars ending now; or replace with from/to below
    Key = Text.Trim(Text.From(Excel.CurrentWorkbook(){[Name = "BridgeKey"]}[Content]{0}[Column1])),
    Raw = Web.Contents(
        BridgeUrl,
        [
            RelativePath = "xl/history",
            Query = [symbol = Symbol, interval = Interval, countback = Countback],
            Headers = [Authorization = "Bearer " & Key, Accept = "text/csv"],
            ManualStatusHandling = {400, 401, 403, 404, 429, 502, 503, 504}
        ]
    ),
    Status = Value.Metadata(Raw)[Response.Status],
    Checked = if Status = 200 then Raw else error Error.Record("Bridge error", "HTTP " & Text.From(Status), Text.FromBinary(Raw)),
    Csv = Csv.Document(Checked, [Delimiter = ",", Encoding = 65001, QuoteStyle = QuoteStyle.Csv]),
    Promoted = Table.PromoteHeaders(Csv, [PromoteAllScalars = true]),
    Typed = Table.TransformColumnTypes(
        Promoted,
        {
            {"datetime", type datetime},
            {"open", type number},
            {"high", type number},
            {"low", type number},
            {"close", type number},
            {"volume", Int64.Type},
            {"oi", Int64.Type}
        },
        "en-IN"
    )
in
    Typed
