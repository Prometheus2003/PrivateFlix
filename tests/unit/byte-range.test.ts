import { expect, it, describe } from "vitest";
import { parseByteRange } from "@/lib/media/byte-range";
describe("HTTP single byte ranges", () => {
  it.each([
    ["bytes=0-0", { start: 0, end: 0 }],
    ["Bytes=0-0", { start: 0, end: 0 }],
    ["bytes=2-5", { start: 2, end: 5 }],
    ["bytes=5-", { start: 5, end: 9 }],
    ["bytes=-3", { start: 7, end: 9 }],
    ["bytes=-100", { start: 0, end: 9 }],
    ["bytes=0-100", { start: 0, end: 9 }],
  ])("parses %s", (header, expected) =>
    expect(parseByteRange(header as string, 10)).toEqual(expected),
  );
  it.each([
    "bytes=10-",
    "bytes=5-2",
    "bytes=-0",
    "bytes=-",
    "bytes=0-1,3-4",
    "bytes=1.5-2",
    "bytes=+1-2",
    "bytes=9007199254740992-",
    "items=0-1",
    "bytes=" + "1".repeat(100) + "-",
  ])("rejects %s", (header) =>
    expect(() => parseByteRange(header, 10)).toThrow(),
  );
  it("does not range a normal response", () =>
    expect(parseByteRange(null, 10)).toBeNull());
});
