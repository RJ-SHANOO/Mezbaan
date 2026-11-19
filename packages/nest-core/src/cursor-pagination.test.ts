import { describe, expect, it } from "vitest";
import { decodeCursor, encodeCursor, toPage } from "./cursor-pagination.js";

describe("encodeCursor/decodeCursor", () => {
  it("round-trips a cursor's createdAt and id", () => {
    const fields = { createdAt: new Date("2026-11-18T10:00:00.000Z"), id: "order-1" };
    expect(decodeCursor(encodeCursor(fields))).toEqual(fields);
  });

  it("rejects garbage base64, unparseable JSON and a missing/malformed field", () => {
    expect(() => decodeCursor("not-base64url-json!!!")).toThrow();
    expect(() => decodeCursor(Buffer.from("not json").toString("base64url"))).toThrow();
    expect(() => decodeCursor(Buffer.from(JSON.stringify({ t: "2026-11-18" })).toString("base64url"))).toThrow();
    expect(() => decodeCursor(Buffer.from(JSON.stringify({ t: "not-a-date", id: "x" })).toString("base64url"))).toThrow();
  });
});

describe("toPage", () => {
  const row = (n: number) => ({ id: `id-${n}`, createdAt: new Date(2026, 0, n) });
  const cursorOf = (r: ReturnType<typeof row>) => ({ createdAt: r.createdAt, id: r.id });

  it("returns every row and a null cursor when fewer than limit+1 came back", () => {
    const rows = [row(3), row(2), row(1)];
    const page = toPage(rows, 10, cursorOf);
    expect(page.items).toEqual(rows);
    expect(page.nextCursor).toBeNull();
  });

  it("trims the over-fetched row and derives nextCursor from the last kept row", () => {
    const rows = [row(5), row(4), row(3), row(2)]; // limit=3, fetched 4
    const page = toPage(rows, 3, cursorOf);
    expect(page.items).toEqual([row(5), row(4), row(3)]);
    expect(page.nextCursor).toBe(encodeCursor(cursorOf(row(3))));
  });

  it("an exact limit-sized result (no over-fetch row) has no next page", () => {
    const rows = [row(2), row(1)];
    const page = toPage(rows, 2, cursorOf);
    expect(page.nextCursor).toBeNull();
  });
});
