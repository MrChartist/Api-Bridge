// Mr. Chartist API Bridge: prices for a whole watchlist in ONE request (Power Query M).
// Use this where WEBSERVICE does not exist (Excel for Mac) or when you want a timed refresh without a macro.
// Needs the Bridge workbook (Setup and Watchlist sheets, from the dashboard or make-template.mjs): it reads the
// ranges named BridgeURL, BridgeKeyCell and WatchlistSymbols. The key is sent as a header, never in the address.
// Read-only: /xl/quotes cannot place orders. Refresh no more often than every 5 seconds: Data > Queries & Connections
// > right-click the query > Properties > Refresh every N minutes (Excel's timer works in whole minutes).
let
    Cell = (name) => Text.Trim(Text.From(Excel.CurrentWorkbook(){[Name = name]}[Content]{0}[Column1])),
    BridgeUrl = Cell("BridgeURL"),
    Key = Cell("BridgeKeyCell"),
    Symbols = List.Select(
        List.Transform(Table.Column(Excel.CurrentWorkbook(){[Name = "WatchlistSymbols"]}[Content], "Column1"), each if _ = null then "" else Text.Trim(Text.From(_))),
        each _ <> ""
    ),
    Raw = Web.Contents(
        BridgeUrl,
        [
            RelativePath = "xl/quotes",
            Query = [symbols = Text.Combine(Symbols, ","), fields = "ltp,chg,pct,volume,bid,ask", format = "csv"],
            Headers = [Authorization = "Bearer " & Key, Accept = "text/csv"],
            ManualStatusHandling = {400, 401, 403, 404, 429, 502, 503, 504}
        ]
    ),
    Status = Value.Metadata(Raw)[Response.Status],
    // On a refusal the Bridge answers a small table whose message says what to do ("Too many refreshes: wait 3 seconds ...").
    Checked = if Status = 200 then Raw else error Error.Record("Bridge error", "HTTP " & Text.From(Status), Text.FromBinary(Raw)),
    Csv = Csv.Document(Checked, [Delimiter = ",", Encoding = 65001, QuoteStyle = QuoteStyle.Csv]),
    Promoted = Table.PromoteHeaders(Csv, [PromoteAllScalars = true]),
    Typed = Table.TransformColumnTypes(
        Promoted,
        {{"ltp", type number}, {"chg", type number}, {"pct", type number}, {"volume", type number}, {"bid", type number}, {"ask", type number}, {"age_s", type number}, {"as_of", type datetime}},
        "en-IN"
    )
in
    Typed
