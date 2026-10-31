/**
 * Curated central-bank decision dates for the central-banks calendar (newsFeeds.mjs). HAND-MAINTAINED DATA, NOT A FEED.
 *
 * VERIFY AGAINST THE OFFICIAL CALENDAR before relying on any date here:
 *   RBI MPC   https://www.rbi.org.in  (Monetary Policy Committee meeting schedule)
 *   US FOMC   https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm
 *   ECB       https://www.ecb.europa.eu/press/calendars/mgcgc/html/index.en.html
 *
 * Only dates the author was confident of are listed; a date that was not certain is omitted rather than guessed, so a
 * meeting missing from this file does NOT mean there is none. In particular the RBI MPC dates and all 2027 FOMC / ECB
 * dates are left out for that reason: add them from the official calendars below (or pass deps.centralBankDates to
 * newsFeedsRoutes, which replaces this list). `date` is the decision / announcement day (ISO, local to the bank);
 * `startDate` is the first meeting day for two-day meetings.
 *
 * Entries: { bank: "RBI"|"FOMC"|"ECB", name, date, startDate? }
 */
export const CENTRAL_BANK_AS_OF = "2026-10-30";

export const CENTRAL_BANK_NOTE =
  "Curated by hand as of 2026-10-30, not fetched. Verify every date against the official calendar (RBI, federalreserve.gov, ecb.europa.eu). Dates the author was unsure of are omitted, so a missing meeting does not mean none is scheduled.";

export const CENTRAL_BANK_DATES = Object.freeze([
  Object.freeze({ bank: "FOMC", name: "FOMC rate decision", startDate: "2026-12-08", date: "2026-12-09" }),
  Object.freeze({ bank: "ECB", name: "ECB monetary policy decision", date: "2026-12-17" }),
]);
