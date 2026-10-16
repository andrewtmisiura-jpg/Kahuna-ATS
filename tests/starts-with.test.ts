import { describe, expect, it } from "vitest";
import { checkStartsWith, cleanStartsWithWord } from "@/server/services/forms/starts-with";

// The "Answer must start with this word" matcher (question_version.starts_with_check).

describe("checkStartsWith", () => {
  it("passes an answer that starts with the word, whatever the case or trailing punctuation", () => {
    for (const answer of ["Blue.", "blue, my best boss was Dana.", "BLUE", "Blue", "  Blue my boss  ", "\"Blue.\" She was fair.", "'Blue' was...", "...Blue!", "Blue-ish day", "Blue2"]) {
      expect(checkStartsWith(answer, "blue"), answer).toBe("pass");
    }
  });

  it("fails an answer where the word is only the start of a longer word, or comes later", () => {
    for (const answer of ["Bluebird", "My answer: Blue", "The best boss. Blue", "Blu", "bleu"]) {
      expect(checkStartsWith(answer, "blue"), answer).toBe("fail");
    }
  });

  it("matches the word as stored, ignoring its own case and spaces", () => {
    expect(checkStartsWith("blue sky", " Blue ")).toBe("pass");
  });

  it("returns nothing when there is no answer or no word", () => {
    expect(checkStartsWith(null, "blue")).toBeNull();
    expect(checkStartsWith("   ", "blue")).toBeNull();
    expect(checkStartsWith("Blue", null)).toBeNull();
    expect(checkStartsWith("Blue", "")).toBeNull();
  });
});

describe("cleanStartsWithWord", () => {
  it("trims a single word, blanks to null, and rejects anything else", () => {
    expect(cleanStartsWithWord(" blue ")).toBe("blue");
    expect(cleanStartsWithWord("")).toBeNull();
    expect(cleanStartsWithWord(null)).toBeNull();
    expect(cleanStartsWithWord("two words")).toBeUndefined();
    expect(cleanStartsWithWord("blue.")).toBeUndefined();
  });
});
