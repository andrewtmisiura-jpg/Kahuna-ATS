import { describe, expect, it } from "vitest";
import { matchName, nameWords } from "@/server/services/sessions/names";

// Name suggestions for attendees (services/sessions/names.ts): the same last name
// with the same first name, or only the same first initial. Never a link on its own.

describe("nameWords", () => {
  it("reads a name the way it is written on a sheet", () => {
    expect(nameWords("  Jon   Smith ")).toEqual(["jon", "smith"]);
    expect(nameWords("Smith, Jon")).toEqual(["jon", "smith"]);
    expect(nameWords("Jon Smith, Jr.")).toEqual(["jon", "smith"]);
    expect(nameWords("José O'Brien-Núñez")).toEqual(["jose", "obrien", "nunez"]);
    expect(nameWords("J. Smith")).toEqual(["j", "smith"]);
  });
});

describe("matchName", () => {
  it("matches the same first and last name in any case", () => {
    expect(matchName("jon smith", "Jon", "Smith")).toBe("same_name");
    expect(matchName("JON SMITH", "jon", "smith")).toBe("same_name");
    expect(matchName("Smith, Jon", "Jon", "Smith")).toBe("same_name");
    expect(matchName("Jon A. Smith", "Jon", "Smith")).toBe("same_name");
    expect(matchName("Mary Ann Van Buren", "Mary Ann", "Van Buren")).toBe("same_name");
  });

  it("matches a first initial with the same last name", () => {
    expect(matchName("J. Smith", "Jon", "Smith")).toBe("initial_and_last");
    expect(matchName("J Smith", "Jonathan", "Smith")).toBe("initial_and_last");
    expect(matchName("Jonathan Smith", "Jon", "Smith")).toBe("initial_and_last");
  });

  it("does not match a different last name, a different initial or a single word", () => {
    expect(matchName("Jon Smyth", "Jon", "Smith")).toBeNull();
    expect(matchName("Bob Smith", "Robert", "Smith")).toBeNull();
    expect(matchName("Smith", "Jon", "Smith")).toBeNull();
    expect(matchName("Jon Smith", null, "Smith")).toBeNull();
    expect(matchName("Jon Smith", "Jon", null)).toBeNull();
    // The last name has to be the end of what was written, not just in it.
    expect(matchName("Smith Jon", "Jon", "Smith")).toBeNull();
  });
});
