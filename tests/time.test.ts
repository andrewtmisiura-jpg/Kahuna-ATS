import { describe, expect, it } from "vitest";
import {
  addDays,
  addWeekdays,
  centralDate,
  centralInstant,
  centralOffsetMinutes,
  daysBetween,
  hourBucket,
  isInSendWindow,
  nextSendWindowStart,
  weekdaysBetween,
} from "@/server/services/time";

// Daylight saving time ends Sun Nov 1, 2026 at 2:00am CDT (07:00Z), when clocks go
// back to 1:00am CST. Every case below sits on or around that change.
const utc = (iso: string) => new Date(iso);

describe("Central-time helper across Nov 1, 2026", () => {
  it("reports the offset on both sides of the change", () => {
    expect(centralOffsetMinutes(utc("2026-11-01T06:30:00Z"))).toBe(-300); // 01:30 CDT
    expect(centralOffsetMinutes(utc("2026-11-01T07:30:00Z"))).toBe(-360); // 01:30 CST
  });

  it("buckets instants into Central calendar dates", () => {
    expect(centralDate(utc("2026-11-01T04:59:00Z"))).toBe("2026-10-31"); // 23:59 CDT
    expect(centralDate(utc("2026-11-01T05:00:00Z"))).toBe("2026-11-01"); // 00:00 CDT
    expect(centralDate(utc("2026-11-01T06:59:00Z"))).toBe("2026-11-01"); // 01:59 CDT
    expect(centralDate(utc("2026-11-02T05:59:00Z"))).toBe("2026-11-01"); // 23:59 CST, a 25-hour day
    expect(centralDate(utc("2026-11-02T06:00:00Z"))).toBe("2026-11-02"); // 00:00 CST
  });

  it("turns 9am Central into the right instant before and after the change", () => {
    expect(centralInstant("2026-10-31", 9).toISOString()).toBe("2026-10-31T14:00:00.000Z");
    expect(centralInstant("2026-11-01", 9).toISOString()).toBe("2026-11-01T15:00:00.000Z");
    expect(centralInstant("2026-11-02", 9).toISOString()).toBe("2026-11-02T15:00:00.000Z");
    expect(centralInstant("2026-11-01", 0).toISOString()).toBe("2026-11-01T05:00:00.000Z");
  });

  it("applies quiet hours around the change", () => {
    // 01:30 CDT on the change night: wait for 9:00 CST, which is 15:00Z, not 14:00Z.
    expect(nextSendWindowStart(utc("2026-11-01T06:30:00Z")).toISOString()).toBe("2026-11-01T15:00:00.000Z");
    // 10:00 CST, inside the window: send now.
    const inside = utc("2026-11-01T16:00:00Z");
    expect(isInSendWindow(inside)).toBe(true);
    expect(nextSendWindowStart(inside)).toBe(inside);
    // 20:00 CST exactly is outside: wait for Monday 9:00 CST.
    const eight = utc("2026-11-02T02:00:00Z");
    expect(isInSendWindow(eight)).toBe(false);
    expect(nextSendWindowStart(eight).toISOString()).toBe("2026-11-02T15:00:00.000Z");
    // 19:59 CST is still inside.
    expect(isInSendWindow(utc("2026-11-02T01:59:00Z"))).toBe(true);
    // Saturday 20:30 CDT: next 9:00 is Sunday 9:00 CST (15:00Z), not 14:00Z.
    expect(nextSendWindowStart(utc("2026-11-01T01:30:00Z")).toISOString()).toBe("2026-11-01T15:00:00.000Z");
  });

  it("puts the 24-hour reminder for a Saturday afternoon start inside Sunday's window", () => {
    // Started Sat Oct 31 at 15:00 CDT; 24 hours later is Sun Nov 1 at 14:00 CST.
    const startedAt = utc("2026-10-31T20:00:00Z");
    const due = new Date(startedAt.getTime() + 24 * 3_600_000);
    expect(centralDate(due)).toBe("2026-11-01");
    expect(isInSendWindow(due)).toBe(true);
    expect(nextSendWindowStart(due)).toBe(due);
  });

  it("counts calendar days and weekdays across the change", () => {
    expect(daysBetween("2026-10-31", "2026-11-02")).toBe(2);
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDays("2026-11-01", -1)).toBe("2026-10-31");
    // Fri Oct 30 plus five weekdays is Fri Nov 6.
    expect(addWeekdays("2026-10-30", 5)).toBe("2026-11-06");
    expect(weekdaysBetween("2026-10-30", "2026-11-06")).toBe(5);
    // Sat Oct 31 plus one weekday is Mon Nov 2.
    expect(addWeekdays("2026-10-31", 1)).toBe("2026-11-02");
    expect(weekdaysBetween("2026-10-31", "2026-11-01")).toBe(0);
    expect(weekdaysBetween("2026-11-06", "2026-11-02")).toBe(0);
    expect(addWeekdays("2026-11-02", 0)).toBe("2026-11-02");
  });

  it("buckets alerts by UTC hour", () => {
    expect(hourBucket(utc("2026-11-01T06:59:59Z"))).toBe("2026-11-01T06");
    expect(hourBucket(utc("2026-11-01T07:00:00Z"))).toBe("2026-11-01T07");
  });
});
