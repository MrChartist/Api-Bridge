// sector-map.js: the broad NSE industry group of each F&O stock, for the right rail's sector heatmap. The same shipped
// list as the Bridge's scanner (server/bridge/scanner/sectors.mjs); right-rail.test.mjs keeps the two identical, so a
// change there fails the test until this copy follows. Pure data: no DOM, no fetch. Check after index changes.

/** sector -> tickers (space separated, as the scanner ships them). A ticker listed twice keeps its first sector. */
const BY_SECTOR = Object.freeze({
  Banks: "HDFCBANK ICICIBANK SBIN KOTAKBANK AXISBANK INDUSINDBK BANKBARODA PNB AUBANK IDFCFIRSTB FEDERALBNK CANBK BANDHANBNK UNIONBANK INDIANB YESBANK RBLBANK",
  "Financial services": "BAJFINANCE BAJAJFINSV SHRIRAMFIN CHOLAFIN MUTHOOTFIN MANAPPURAM LICHSGFIN PFC RECLTD IRFC SBICARD HDFCAMC ICICIGI ICICIPRULI HDFCLIFE SBILIFE LICI JIOFIN POONAWALLA ABCAPITAL L&TFH M&MFIN ANGELONE BSE CDSL MCX CAMS IIFL PNBHOUSING SBICARD 360ONE NUVAMA KFINTECH HUDCO IREDA",
  IT: "TCS INFY HCLTECH WIPRO TECHM LTIM PERSISTENT COFORGE MPHASIS OFSS KPITTECH TATAELXSI CYIENT TATATECH",
  Auto: "MARUTI M&M TMPV BAJAJ-AUTO EICHERMOT HEROMOTOCO TVSMOTOR ASHOKLEY BHARATFORG MOTHERSON BOSCHLTD EXIDEIND SONACOMS TIINDIA UNOMINDA",
  Pharma: "SUNPHARMA CIPLA DRREDDY DIVISLAB LUPIN AUROPHARMA ZYDUSLIFE ALKEM TORNTPHARM BIOCON GLENMARK LAURUSLABS MANKIND GRANULES",
  Healthcare: "APOLLOHOSP MAXHEALTH FORTIS SYNGENE",
  FMCG: "HINDUNILVR ITC NESTLEIND BRITANNIA TATACONSUM DABUR MARICO GODREJCP COLPAL VBL UNITDSPR PATANJALI",
  Metals: "TATASTEEL JSWSTEEL HINDALCO VEDL SAIL NMDC JINDALSTEL NATIONALUM HINDZINC APLAPOLLO",
  Energy: "RELIANCE ONGC NTPC POWERGRID COALINDIA BPCL IOC HINDPETRO GAIL OIL PETRONET ADANIGREEN ADANIENSOL TATAPOWER NHPC JSWENERGY TORNTPOWER SJVN IGL CESC",
  Capital: "LT BEL HAL BHEL SIEMENS ABB CGPOWER CUMMINSIND POLYCAB KEI SUPREMEIND BDL MAZDOCK SOLARINDS",
  Cement: "ULTRACEMCO GRASIM SHREECEM AMBUJACEM DALBHARAT",
  Consumer: "TITAN ASIANPAINT PIDILITIND HAVELLS VOLTAS DIXON KALYANKJIL BLUESTARCO PAGEIND TRENT DMART NYKAA ETERNAL SWIGGY JUBLFOOD INDHOTEL IRCTC",
  Telecom: "BHARTIARTL IDEA INDUSTOWER TATACOMM",
  Infrastructure: "ADANIENT ADANIPORTS GMRAIRPORT CONCOR INDIGO DLF GODREJPROP LODHA OBEROIRLTY PRESTIGE PHOENIXLTD NBCC RVNL IRB",
  Chemicals: "UPL PIIND SRF DEEPAKNTR AARTIIND TATACHEM COROMANDEL",
  Media: "PVRINOX SUNTV",
  Insurance: "POLICYBZR",
});

/** ticker -> sector */
const SECTOR = new Map();
for (const [sector, list] of Object.entries(BY_SECTOR)) for (const t of list.split(" ")) if (t && !SECTOR.has(t)) SECTOR.set(t, sector);

/** Every sector name, in the shipped order. */
export const SECTORS = Object.freeze(Object.keys(BY_SECTOR));
/** Every ticker the list knows, sorted. */
export const SECTOR_TICKERS = Object.freeze([...SECTOR.keys()].sort());
/** The sector of "NSE:RELIANCE" or "RELIANCE"; null when the list does not name it. */
export const sectorOf = (symbol) => SECTOR.get(String(symbol ?? "").split(":").pop().trim().toUpperCase()) ?? null;
/** How a sector reads on screen ("Capital" is the capital goods group). */
export const sectorLabel = (sector) => (sector === "Capital" ? "Capital goods" : sector ?? "Other");
