import { describe, expect, it } from "vitest";
import { MAX_TAGS, filterByTags, matchesTags, normaliseTags, parseTagFilter, validateName } from "./tags.mjs";

/** The helper the datasets of the downloads module call. These tests use it exactly the way a dataset store would. */
describe("normaliseTags", () => {
  it("lower-cases, trims, de-duplicates and sorts", () => {
    expect(normaliseTags(["Nifty", " weekly ", "nifty", "A_b.c:d-e"])).toEqual(["a_b.c:d-e", "nifty", "weekly"]);
  });
  it("takes a comma separated string and ignores blanks and nothing", () => {
    expect(normaliseTags("b, a,,A")).toEqual(["a", "b"]);
    expect(normaliseTags(undefined)).toEqual([]);
    expect(normaliseTags(null)).toEqual([]);
    expect(normaliseTags("")).toEqual([]);
    expect(normaliseTags([" ", ""])).toEqual([]);
  });
  it("refuses a bad tag, naming it and its place", () => {
    expect(() => normaliseTags(["ok", "has space"])).toThrow(expect.objectContaining({ code: "VALIDATION_FAILED", errors: [{ path: "tags.1", message: expect.stringContaining("has space") }] }));
    expect(() => normaliseTags(["-start"])).toThrow();
    expect(() => normaliseTags(["x".repeat(33)])).toThrow();
    expect(() => normaliseTags([5])).toThrow(/must be text/);
    expect(() => normaliseTags({ a: 1 })).toThrow(/list of words/);
  });
  it("allows at most 20 tags, and the path can be set for the caller's field name", () => {
    expect(normaliseTags(Array.from({ length: MAX_TAGS }, (_, i) => `t${i}`))).toHaveLength(MAX_TAGS);
    expect(() => normaliseTags(Array.from({ length: MAX_TAGS + 1 }, (_, i) => `t${i}`))).toThrow(/at most 20/);
    expect(() => normaliseTags(["BAD TAG"], "dataset.tags")).toThrow(expect.objectContaining({ errors: [{ path: "dataset.tags.0", message: expect.any(String) }] }));
  });
});

describe("tag filters (?tag=a,b)", () => {
  const items = [
    { name: "n5", tags: ["nifty", "5m"] },
    { name: "n1d", tags: ["nifty", "1d"] },
    { name: "b5", tags: ["banknifty", "5m"] },
    { name: "none" },
  ];
  it("parses a string, repeated parameters and junk", () => {
    expect(parseTagFilter("Nifty, 5m")).toEqual(["nifty", "5m"]);
    expect(parseTagFilter(["a,b", "c", "a"])).toEqual(["a", "b", "c"]);
    expect(parseTagFilter(undefined)).toEqual([]);
    expect(parseTagFilter("")).toEqual([]);
  });
  it("an item matches when it has EVERY wanted tag", () => {
    expect(matchesTags(["a", "b"], ["a"])).toBe(true);
    expect(matchesTags(["a", "b"], ["a", "c"])).toBe(false);
    expect(matchesTags(undefined, [])).toBe(true);
    expect(matchesTags(undefined, ["a"])).toBe(false);
  });
  it("filters a list, and no filter keeps everything", () => {
    expect(filterByTags(items, "nifty").map((x) => x.name)).toEqual(["n5", "n1d"]);
    expect(filterByTags(items, "nifty,5m").map((x) => x.name)).toEqual(["n5"]);
    expect(filterByTags(items, ["5m"]).map((x) => x.name)).toEqual(["n5", "b5"]);
    expect(filterByTags(items, "")).toBe(items);
    expect(filterByTags(items, undefined)).toBe(items);
    expect(filterByTags([{ meta: { tags: ["z"] } }], "z", (x) => x.meta.tags)).toHaveLength(1);
  });
});

describe("validateName (collection, dataset and file names)", () => {
  it("accepts letters, digits and _ . -, trimmed", () => {
    expect(validateName("  nifty-5m_v1.2 ")).toBe("nifty-5m_v1.2");
  });
  it("refuses spaces, slashes, a leading dot, empty and too long", () => {
    for (const bad of ["a b", "a/b", ".hidden", "", "  ", "x".repeat(65), "../etc", undefined, 5]) {
      expect(() => validateName(bad), String(bad)).toThrow(expect.objectContaining({ code: "VALIDATION_FAILED" }));
    }
  });
});
