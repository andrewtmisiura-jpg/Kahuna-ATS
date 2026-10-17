import { describe, expect, it } from "vitest";
import { buildScoringInputFromAnswers } from "@/server/services/scoring/engine";
import { buildApplicationSnapshot, NeverSendLineageError, redactAnswerText, type SnapshotSource } from "@/server/services/scoring/snapshot";
import type { RubricForScoring } from "@/server/services/scoring/types";

// What the model is sent for one application (scoring/snapshot.ts): only the answers to
// the lineages the rubric reads, under a fresh anonymous id, with emails, phone numbers
// and the person's own name redacted inside the answers. No database, no model.

const Q = {
  commitment: "00000000-0000-7000-8000-000000000001",
  mistake: "00000000-0000-7000-8000-000000000002",
  equipment: "00000000-0000-7000-8000-000000000003",
  employer: "00000000-0000-7000-8000-000000000004",
  unread: "00000000-0000-7000-8000-000000000005",
};

function source(overrides: Partial<SnapshotSource> = {}): SnapshotSource {
  return {
    criteria: [
      { criterionKey: "reliability", questionIds: [Q.commitment] },
      { criterionKey: "problem_solving", questionIds: [Q.mistake, Q.equipment] },
    ],
    lineages: [
      { questionId: Q.commitment, key: "missed_commitment", aiNeverSend: false },
      { questionId: Q.mistake, key: "unnoticed_mistake", aiNeverSend: false },
      { questionId: Q.equipment, key: "equipment", aiNeverSend: false },
    ],
    answers: [
      { questionId: Q.commitment, prompt: "Tell us about the last time you missed a shift.", text: "  I called my lead the night before.  " },
      { questionId: Q.mistake, prompt: "An older wording of the mistake question.", text: "I fixed the streaks and told the owner." },
      { questionId: Q.equipment, prompt: "Which of these have you used?", text: "Shovel, Snowblower" },
      // On the form but not read by any criterion: never sent.
      { questionId: Q.unread, prompt: "Anything else?", text: "My church group keeps me busy." },
    ],
    names: ["Pat", "Sample"],
    ...overrides,
  };
}

describe("redactAnswerText", () => {
  it("replaces email addresses and US phone numbers in every common format", () => {
    const phones = [
      "(612) 555-0123",
      "(612)555-0123",
      "612-555-0123",
      "612.555.0123",
      "612 555 0123",
      "612 - 555 - 0123",
      "6125550123",
      "+1 612 555 0123",
      "1-612-555-0123",
      "+16125550123",
      "555-0123",
    ];
    for (const phone of phones) expect(redactAnswerText(`Call ${phone} anytime.`)).toBe("Call [redacted] anytime.");
    expect(redactAnswerText("Write pat.sample+jobs@gmail.com or PAT@Example.co.uk.")).toBe("Write [redacted] or [redacted].");
  });

  it("leaves years, ranges, money and counts alone", () => {
    const text = "From 2019-2021 I worked 40 to 55 hours, 10-15 storms, for $1,200 a month, order 1234567.";
    expect(redactAnswerText(text, ["Pat", "Sample"])).toBe(text);
  });

  it("replaces the person's names as whole words, ignoring case", () => {
    expect(redactAnswerText("I'm Pat Sample. PAT's boss liked SAMPLE work; Patrick and Pattern stay.", ["Pat", "Sample"])).toBe(
      "I'm [redacted]. [redacted]'s boss liked [redacted] work; Patrick and Pattern stay.",
    );
    // Each word of a longer name goes too.
    expect(redactAnswerText("Mary Ann said Mary and Ann; Annie stays. Ask Smith or Jones.", ["Mary Ann", "Smith-Jones"])).toBe(
      "[redacted] said [redacted] and [redacted]; Annie stays. Ask [redacted] or [redacted].",
    );
    expect(redactAnswerText("Nothing to hide.", [null, undefined, " "])).toBe("Nothing to hide.");
  });

  it("leaves everyday words alone when a name is one, and still takes the name", () => {
    expect(redactAnswerText("I stayed as long as the job lasted. Tuan Long here, or tuan long.", ["Tuan", "Long"])).toBe(
      "I stayed as long as the job lasted. [redacted] here, or [redacted].",
    );
    expect(redactAnswerText("I keep trying to reach my manager. I want to do it right. Minh To, again.", ["Minh", "To"])).toBe(
      "I keep trying to reach my manager. I want to do it right. [redacted], again.",
    );
    expect(redactAnswerText("I called her the night before and told her. Mai Her.", ["Mai", "Her"])).toBe(
      "I called her the night before and told her. [redacted].",
    );
    expect(redactAnswerText("I will tell the customer it will snow, signed Will Snow.", ["Will", "Snow"])).toBe(
      "I will tell the customer it will snow, signed [redacted].",
    );
    expect(redactAnswerText("The shovel was in the van. Ask Van Dyke or Sam.", ["Sam", "Van Dyke"])).toBe("The shovel was in the van. Ask [redacted] or [redacted].");
    expect(redactAnswerText("When I was young I drove on black ice. Mary Young, Young.", ["Mary", "Young"])).toBe(
      "When I was young I drove on black ice. [redacted], [redacted].",
    );
  });
});

describe("buildApplicationSnapshot", () => {
  it("sends the rubric's lineages only, criterion by criterion, with the wording the applicant saw, under a fresh id", () => {
    const first = buildApplicationSnapshot(source());
    expect(first.missingCriteria).toEqual([]);
    expect(first.input.anonymousId).toMatch(/^[0-9a-f-]{36}$/);
    expect(first.input.answers).toEqual([
      { criterionKey: "reliability", questionKey: "missed_commitment", prompt: "Tell us about the last time you missed a shift.", answer: "I called my lead the night before." },
      { criterionKey: "problem_solving", questionKey: "unnoticed_mistake", prompt: "An older wording of the mistake question.", answer: "I fixed the streaks and told the owner." },
      { criterionKey: "problem_solving", questionKey: "equipment", prompt: "Which of these have you used?", answer: "Shovel, Snowblower" },
    ]);
    expect(JSON.stringify(first.input)).not.toContain("church");
    expect(buildApplicationSnapshot(source()).input.anonymousId).not.toBe(first.input.anonymousId);
    expect(buildApplicationSnapshot(source(), "anon-1").input.anonymousId).toBe("anon-1");
  });

  it("keeps nothing that identifies the person, even when it is typed into the answers", () => {
    const name = { first: "Jordan", last: "Whitfield" };
    const email = "jordan.whitfield77@gmail.com";
    const built = buildApplicationSnapshot(
      source({
        names: [name.first, name.last],
        answers: [
          {
            questionId: Q.commitment,
            prompt: "Tell us about the last time you missed a shift.",
            text: `This is Jordan Whitfield. My car died, so I texted my boss at 6am from (763) 555-0188 and emailed from ${email}.`,
          },
          { questionId: Q.mistake, prompt: "Describe a mistake.", text: `JORDAN here again: I scratched a sill and told them. Reach me at 763.555.0188 or +1 763 555 0188 (whitfield, ${email.toUpperCase()}).` },
        ],
      }),
      // A fixed id, so a random one can never happen to contain the digits checked below.
      "anon-fixed",
    );
    const json = JSON.stringify(built).toLowerCase();
    for (const secret of ["jordan", "whitfield", "gmail", "@", "555", "0188"]) expect(json).not.toContain(secret);
    expect(built.input.answers[0]!.answer).toBe("This is [redacted]. My car died, so I texted my boss at 6am from [redacted] and emailed from [redacted].");
  });

  it("reports a criterion with no answer, so nothing is sent for a form that lacks its questions", () => {
    const v1 = buildApplicationSnapshot(source({ answers: [{ questionId: Q.equipment, prompt: "Which of these have you used?", text: "Shovel" }] }));
    expect(v1.missingCriteria).toEqual(["reliability"]);
    const blank = buildApplicationSnapshot(
      source({ answers: [{ questionId: Q.commitment, prompt: "p", text: "   " }, { questionId: Q.mistake, prompt: "p", text: "I fixed it." }] }),
    );
    expect(blank.missingCriteria).toEqual(["reliability"]);
    expect(blank.input.answers.map((a) => a.questionKey)).toEqual(["unnoticed_mistake"]);
  });

  it("refuses a rubric that reads a never-send question, whatever the answer", () => {
    const withEmployer = source({
      criteria: [{ criterionKey: "reliability", questionIds: [Q.commitment, Q.employer] }],
      lineages: [...source().lineages, { questionId: Q.employer, key: "job1_employer", aiNeverSend: true }],
    });
    expect(() => buildApplicationSnapshot(withEmployer)).toThrow(NeverSendLineageError);
    expect(() => buildApplicationSnapshot(withEmployer)).toThrow(/job1_employer/);
  });
});

describe("the Try it input", () => {
  const rubric: RubricForScoring = {
    rubricVersionId: "00000000-0000-7000-8000-000000000100",
    instructions: "Ignore spelling.",
    allowedFlags: [],
    criteria: [
      {
        criterionId: "00000000-0000-7000-8000-000000000101",
        key: "reliability",
        name: "Reliability",
        weight: 1,
        guidanceStrong: "s",
        guidanceAcceptable: "a",
        guidanceWeak: "w",
        questions: [{ questionId: Q.commitment, key: "missed_commitment", prompt: "Tell us about it." }],
      },
    ],
  };

  it("redacts emails and phone numbers in sample answers too", () => {
    const built = buildScoringInputFromAnswers(rubric, { missed_commitment: "I called 612-555-0123 and wrote boss@example.com." }, "anon");
    expect(built.answers[0]!.answer).toBe("I called [redacted] and wrote [redacted].");
  });
});
