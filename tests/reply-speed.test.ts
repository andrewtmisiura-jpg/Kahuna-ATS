import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, sql } from "@/db";
import { message } from "@/db/schema";
import { seedPhase1 } from "@/db/seed";
import { uuidv7 } from "@/lib/uuid";
import { loadProfile } from "@/server/services/applications/queries";
import { computeReplySpeed, describeReplySpeed, median, replySpeedByPerson, type ReplyMessage } from "@/server/services/messaging/reply-speed";
import { withRollback } from "./helpers/db";
import { createApplication, createPerson, loadSnow, TEST_ADMIN_EMAIL, type SnowFixture } from "./helpers/fixtures";

// Text reply speed: the median minutes from our most recent sent message (text or
// email) to each inbound text after it, ignoring keyword texts and texts with no
// earlier outbound message.

const T0 = new Date("2026-10-20T15:00:00Z");
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);
const out = (minutes: number, channel: "sms" | "email" = "sms"): ReplyMessage => ({ direction: "outbound", channel, at: at(minutes), body: null });
const text = (minutes: number, body = "Sounds good"): ReplyMessage => ({ direction: "inbound", channel: "sms", at: at(minutes), body });

let snow: SnowFixture;

beforeAll(async () => {
  await seedPhase1(db, { adminEmail: TEST_ADMIN_EMAIL });
  snow = await loadSnow(db);
});

afterAll(async () => {
  await sql.end();
});

describe("computeReplySpeed", () => {
  it("measures each inbound text from the most recent outbound message before it, and takes the median", () => {
    const speed = computeReplySpeed([out(0), text(12), out(100, "email"), text(130), out(200), text(203)]);
    // 12, 30 and 3 minutes.
    expect(speed).toEqual({ medianMinutes: 12, replies: 3 });
    expect(describeReplySpeed(speed)).toBe("Median 12 min across 3 replies");
  });

  it("counts every text after the same outbound message from that message", () => {
    expect(computeReplySpeed([out(0), text(10), text(20)])).toEqual({ medianMinutes: 15, replies: 2 });
  });

  it("ignores STOP, START, HELP and the other keyword texts", () => {
    const keywords = ["STOP", "stop.", "Unsubscribe", "START", "UNSTOP", "HELP", "opt out", "Quit!"];
    const speed = computeReplySpeed([out(0), ...keywords.map((body, i) => text(i + 1, body)), text(40, "Stop by at 5?")]);
    expect(speed).toEqual({ medianMinutes: 40, replies: 1 });
  });

  it("ignores texts with no earlier outbound message, and inbound email", () => {
    const speed = computeReplySpeed([text(0, "Hi, is this the hiring line?"), out(5), { direction: "inbound", channel: "email", at: at(6), body: "Thanks" }]);
    expect(speed).toEqual({ medianMinutes: null, replies: 0 });
    expect(describeReplySpeed(speed)).toBe("No replies yet");
  });

  it("does not count a text that arrived at the same moment as the message", () => {
    expect(computeReplySpeed([text(0), out(0)])).toEqual({ medianMinutes: null, replies: 0 });
  });

  it("takes the middle of an even count and orders out-of-order input", () => {
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(computeReplySpeed([text(70), out(0), text(5), out(60)])).toEqual({ medianMinutes: 7.5, replies: 2 });
  });

  it("reads one reply in the singular and long gaps in hours", () => {
    expect(describeReplySpeed({ medianMinutes: 125, replies: 1 })).toBe("Median 2 h 5 min across 1 reply");
  });
});

describe("replySpeedByPerson", () => {
  it("uses the time a message was sent, skips messages never sent, and shows on the profile", async () => {
    await withRollback(db, async (tx) => {
      const personId = await createPerson(tx);
      const { applicationId } = await createApplication(tx, snow, personId);
      const row = (values: Partial<typeof message.$inferInsert>) =>
        tx.insert(message).values({
          id: uuidv7(),
          personId,
          applicationId,
          toAddress: "+16125550100",
          fromAddress: "+17632922259",
          provider: "sink",
          triggeredByType: "system",
          direction: "outbound",
          channel: "sms",
          status: "sent",
          ...values,
        });
      // Sent at 0; a text 20 minutes later counts.
      await row({ createdAt: at(-30), sentAt: at(0) });
      await row({ direction: "inbound", status: "received", provider: "quo", body: "Yes I can come", createdAt: at(20) });
      // Queued but never sent: not an outbound message the person saw.
      await row({ status: "suppressed", createdAt: at(30), sentAt: null });
      await row({ direction: "inbound", status: "received", provider: "quo", body: "Also, what time?", createdAt: at(50) });
      // A STOP is ignored.
      await row({ direction: "inbound", status: "received", provider: "quo", body: "STOP", createdAt: at(55) });

      const speeds = await replySpeedByPerson(tx, [personId]);
      expect(speeds.get(personId)).toEqual({ medianMinutes: 35, replies: 2 });

      const profile = await loadProfile(tx, applicationId, "viewer");
      expect(profile!.replySpeed).toEqual({ medianMinutes: 35, replies: 2, label: "Median 35 min across 2 replies" });
    });
  });

  it("leaves out texts that failed after they were sent and the automatic HELP reply", async () => {
    await withRollback(db, async (tx) => {
      const personId = await createPerson(tx);
      const { applicationId } = await createApplication(tx, snow, personId);
      const row = (values: Partial<typeof message.$inferInsert>) =>
        tx.insert(message).values({
          id: uuidv7(),
          personId,
          applicationId,
          toAddress: "+16125550100",
          fromAddress: "+17632922259",
          provider: "sink",
          triggeredByType: "system",
          direction: "outbound",
          channel: "sms",
          status: "sent",
          ...values,
        });
      const inbound = (minutes: number, body: string) =>
        row({ direction: "inbound", status: "received", provider: "quo", body, createdAt: at(minutes) });

      // An email at 0 reached them; a reminder text at 60 was accepted, then the
      // carrier reported it undelivered. Their text at 90 answers the email.
      await row({ channel: "email", provider: "resend", toAddress: "pat@example.test", createdAt: at(0), sentAt: at(0) });
      await row({ status: "undelivered", createdAt: at(60), sentAt: at(60), failedAt: at(61) });
      await inbound(90, "Got your email, thanks");
      // A text at 200 marked failed by status alone is left out too.
      await row({ createdAt: at(200), sentAt: at(200) });
      await row({ status: "failed", createdAt: at(250), sentAt: at(250) });
      await inbound(260, "Yes");
      // HELP at 400 is ignored and so is the reply we send back at 401; the real
      // answer at 421 is measured from the text at 380.
      await row({ createdAt: at(380), sentAt: at(380) });
      await inbound(400, "HELP");
      await row({ purpose: "help_reply", createdAt: at(401), sentAt: at(401) });
      await inbound(421, "Yes I'll be there");

      // 90, 60 and 41 minutes.
      expect((await replySpeedByPerson(tx, [personId])).get(personId)).toEqual({ medianMinutes: 60, replies: 3 });
    });
  });

  it("returns no replies for a person with no messages", async () => {
    const personId = await createPerson(db);
    expect((await replySpeedByPerson(db, [personId])).get(personId)).toEqual({ medianMinutes: null, replies: 0 });
  });
});
