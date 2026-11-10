// Mr. Chartist API Bridge — option chain, one row per strike (Power Query M).
// Needs the Bridge workbook (Setup sheet, from the dashboard or make-template.mjs): it reads the ranges named BridgeURL
// and BridgeKeyCell, which are plain cells. (Power Query can read a named range or table, not a name that holds a
// formula, which is why it does not read the name BridgeKey.) The key is sent as a header, not in the URL.
// Not tested in real Excel here: if Power Query says it cannot find a name, check Formulas > Name Manager.
// Read-only: /xl/chain cannot place orders. Refresh no more than once a minute; the Bridge serves the chain from its
// live stream and cache, within your broker's limits.
let
    Cell = (name) => Text.Trim(Text.From(Excel.CurrentWorkbook(){[Name = name]}[Content]{0}[Column1])),
    BridgeUrl = Cell("BridgeURL"),
    Underlying = "NIFTY",
    Expiry = "2026-11-24",      // CHANGE THIS to a current expiry (YYYY-MM-DD): an expired date gives "No ... expiry". List them with GET /v1/expiries?underlying=NIFTY
    Strikes = "15",             // strikes on each side of ATM
    Key = Cell("BridgeKeyCell"),
    Raw = Web.Contents(
        BridgeUrl,
        [
            RelativePath = "xl/chain",
            Query = [underlying = Underlying, expiry = Expiry, strikes = Strikes, format = "csv"],
            Headers = [Authorization = "Bearer " & Key, Accept = "text/csv"],
            ManualStatusHandling = {400, 401, 403, 404, 429, 502, 503, 504}
        ]
    ),
    Status = Value.Metadata(Raw)[Response.Status],
    Checked = if Status = 200 then Raw else error Error.Record("Bridge error", "HTTP " & Text.From(Status), Text.FromBinary(Raw)),
    Csv = Csv.Document(Checked, [Delimiter = ",", Encoding = 65001, QuoteStyle = QuoteStyle.Csv]),
    Promoted = Table.PromoteHeaders(Csv, [PromoteAllScalars = true]),
    NumberColumns = List.Select(
        Table.ColumnNames(Promoted),
        each not List.Contains({"underlying", "expiry", "atm", "ce_symbol", "pe_symbol", "as_of", "source", "stale"}, _)
    ),
    Typed = Table.TransformColumnTypes(
        Promoted,
        List.Combine({
            List.Transform(NumberColumns, each {_, type number}),
            {{"expiry", type date}, {"atm", type logical}, {"stale", type logical}, {"as_of", type datetime}}
        }),
        "en-IN"
    )
in
    Typed
