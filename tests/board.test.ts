import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, sql } from "@/db";
import { application, applicationEvent, groupSession, hireStint, message, pipelineStage, role } from "@/db/schema";
import { seedPhase1 } from "@/db/seed";
import { uuidv7 } from "@/lib/uuid";
import {
  boardFilterParams,
  boardFiltersActive,
  loadBoard,
  loadBoardStint,
  moveBoardCard,
  parseBoardFilters,
  type Board,
  type BoardCard,
  type BoardFilters,
} from "@/server/services/applications/board";
import { createApplication, StaleVersionError, transition, TransitionError } from "@/server/services/applications/transition";
import { addDays, centralDate, centralInstant } from "@/server/services/time";
import { createPerson, loadAdminId, loadOption, loadSnow, loadStages, TEST_ADMIN_EMAIL, type SnowFixture } from "./helpers/fixtures";
import { withRollback } from "./helpers/db";

// The kanban board's query and its plain-stage move. Test files share one
// database and the seed test counts the configuration tables exactly, so the
// fixtures live on the seeded snow opening and every surname carries a tag
// that the board's name search isolates. Configuration changes (an archived
// stage, a stage taken off the board) run in a transaction that is rolled back.

const TAG = "Qzboard";
const n = (name: string) => `${name}${TAG}`;

let snow: SnowFixture;
let stages: Record<string, string>;
let staff: { type: "staff"; userId: string };
let adminId: string;
let openingId: string;
let sessionId: string;
let codeId: string;
const ids: Record<string, string> = {};

const applicant = { type: "applicant" } as const;
const today = () => centralDate(new Date());

async function start(name: string, options: { entryCodeId?: string; session?: boolean; startedAt?: Date } = {}) {
  const [first, last] = name.split(" ");
  const personId = await createPerson(db, { firstName: first, lastName: n(last!) });
  const { applicationId } = await createApplication(db, {
    personId,
    openingId,
    origin: "staff_created",
    entryCodeId: options.entryCodeId ?? null,
    entryChannel: "staff_entered",
    scannedSessionId: options.session ? sessionId : null,
    actor: applicant,
    occurredAt: options.startedAt,
  });
  ids[name] = applicationId;
  return { applicationId, personId };
}

async function submitted(name: string, options: Parameters<typeof start>[1] & { submittedAt?: Date } = {}) {
  const created = await start(name, options);
  await transition(db, { action: "submit", applicationId: created.applicationId, actor: applicant, occurredAt: options.submittedAt });
  return created;
}

async function historicalStint(personId: string, rehireEligible: boolean) {
  const [snowRole] = await db.select({ employerId: role.employerId }).from(role).where(eq(role.id, snow.roleId));
  await db.insert(hireStint).values({
    id: uuidv7(),
    personId,
    applicationId: null,
    origin: "historical_import",
    employerId: snowRole!.employerId,
    roleId: snow.roleId,
    openingId: null,
    outcome: "completed_season",
    endOn: "2026-03-15",
    rehireEligible,
  });
}

beforeAll(async () => {
  await seedPhase1(db, { adminEmail: TEST_ADMIN_EMAIL });
  snow = await loadSnow(db);
  stages = await loadStages(db, snow.roleId);
  adminId = await loadAdminId(db);
  staff = { type: "staff", userId: adminId };
  openingId = snow.openingId;

  sessionId = uuidv7();
  await db.insert(groupSession).values({
    id: sessionId,
    openingId,
    startsAt: new Date("2026-10-21T23:00:00Z"),
    locationName: `Plymouth shop ${TAG}`,
    status: "scheduled",
    createdBy: adminId,
  });
  const [code] = await sql<{ id: string }[]>`select id from entry_code where code = 'SNW26QR'`;
  codeId = code!.id;

  // Submitted through the role QR: a Submitted card showing the entry code.
  await submitted("Ann Submitted", { entryCodeId: codeId });
  // Submitted from a group session: the card shows the session instead.
  await submitted("Ben Session", { session: true });
  // Reviewed, on hold, with an unhandled text.
  const cal = await submitted("Cal Reviewed");
  await transition(db, { action: "move", applicationId: cal.applicationId, toStageId: stages.reviewed!, actor: staff });
  await transition(db, { action: "hold", applicationId: cal.applicationId, actor: staff });
  await db.insert(message).values({
    id: uuidv7(),
    direction: "inbound",
    channel: "sms",
    personId: cal.personId,
    applicationId: cal.applicationId,
    toAddress: "+17632922259",
    fromAddress: "+16125550188",
    body: "Running late",
    status: "received",
    provider: "quo",
    providerMessageId: `quo-board-${cal.applicationId}`,
    triggeredByType: "applicant",
  });
  // Started only: a count, not a card.
  await start("Dee Started");
  // Submitted then closed: a count, not a card.
  const eve = await submitted("Eve Closed");
  await transition(db, {
    action: "close",
    applicationId: eve.applicationId,
    outcome: "withdrew",
    reasonOptionId: await loadOption(db, "withdraw_reason", "stopped_responding"),
    actor: staff,
  });
  // Hired as a temporary hire.
  const fay = await submitted("Fay Hired");
  await transition(db, { action: "move", applicationId: fay.applicationId, toStageId: stages.hired!, actor: staff, hire: { isTemporary: true } });
  // Returning: an earlier stint not eligible for rehire, and one that is.
  const gus = await submitted("Gus Returning");
  await historicalStint(gus.personId, false);
  const hal = await submitted("Hal Returning");
  await historicalStint(hal.personId, true);
  // Submitted three Central days ago and still in Submitted.
  await submitted("Ida Waiting", { startedAt: centralInstant(addDays(today(), -4), 12), submittedAt: centralInstant(addDays(today(), -3), 12) });
  // A deleted test application never shows.
  const jon = await submitted("Jon Deleted");
  await db.update(application).set({ deletedAt: new Date() }).where(eq(application.id, jon.applicationId));
  // In the check stage with an open background check.
  const kim = await submitted("Kim Checked");
  await transition(db, { action: "move", applicationId: kim.applicationId, toStageId: stages.conditional_offer!, actor: staff });
  await transition(db, {
    action: "move",
    applicationId: kim.applicationId,
    toStageId: stages.background_check!,
    actor: staff,
    check: { checkType: "driving_record" },
  });
});

afterAll(async () => {
  await sql.end();
});

function filters(extra: Partial<BoardFilters> = {}): BoardFilters {
  return { openingId, search: TAG, ...extra };
}

function allCards(board: Board): BoardCard[] {
  return board.columns.flatMap((column) => column.cards);
}

function card(board: Board, name: string): BoardCard {
  const found = allCards(board).find((c) => `${c.firstName} ${c.lastName}` === n(name));
  if (!found) throw new Error(`${name} is not on the board`);
  return found;
}

async function names(extra: Partial<BoardFilters> = {}) {
  const board = await loadBoard(db, filters(extra), "admin");
  return allCards(board)
    .map((c) => `${c.firstName} ${c.lastName}`)
    .sort();
}

function columnOf(board: Board, name: string): string {
  const column = board.columns.find((col) => col.cards.some((c) => `${c.firstName} ${c.lastName}` === n(name)));
  return column?.stage.key ?? "none";
}

describe("columns", () => {
  it("has one column per stage shown on the board, in sort order, without Started", async () => {
    const board = await loadBoard(db, filters(), "admin");
    expect(board.columns.map((c) => c.stage.key)).toEqual([
      "submitted",
      "reviewed",
      "one_on_one_invited",
      "one_on_one_done",
      "conditional_offer",
      "background_check",
      "hired",
    ]);
    expect(board.columns.map((c) => c.stage.name)).toContain("Background or driving check");
    const orders = board.columns.map((c) => c.stage.sortOrder);
    expect(orders).toEqual([...orders].sort((a, b) => a - b));
    // The Move dialog gets every stage of the role.
    expect(board.stages.map((s) => s.key)).toContain("started");
  });

  it("leaves out archived stages and stages taken off the board, and counts the cards left in them", async () => {
    await withRollback(db, async (tx) => {
      await tx.update(pipelineStage).set({ archivedAt: new Date() }).where(eq(pipelineStage.id, stages.reviewed!));
      await tx.update(pipelineStage).set({ showOnBoard: false }).where(eq(pipelineStage.id, stages.one_on_one_done!));
      const board = await loadBoard(tx, filters(), "admin");
      const keys = board.columns.map((c) => c.stage.key);
      expect(keys).not.toContain("reviewed");
      expect(keys).not.toContain("one_on_one_done");
      expect(keys).toContain("one_on_one_invited");
      // Cal sits in the archived Reviewed stage.
      expect(board.counts.offBoard).toBe(1);
      expect(allCards(board).some((c) => c.id === ids["Cal Reviewed"])).toBe(false);
    });
  });

  it("puts each card in its stage's column", async () => {
    const board = await loadBoard(db, filters(), "admin");
    expect(columnOf(board, "Ann Submitted")).toBe("submitted");
    expect(columnOf(board, "Cal Reviewed")).toBe("reviewed");
    expect(columnOf(board, "Fay Hired")).toBe("hired");
    expect(columnOf(board, "Kim Checked")).toBe("background_check");
    expect(board.counts.offBoard).toBe(0);
  });
});

describe("cards and counts", () => {
  it("leaves started, closed and deleted applications off the board and counts started and closed", async () => {
    const board = await loadBoard(db, filters(), "admin");
    expect(await names()).toEqual(
      ["Ann Submitted", "Ben Session", "Cal Reviewed", "Fay Hired", "Gus Returning", "Hal Returning", "Ida Waiting", "Kim Checked"].map(n),
    );
    expect(board.counts.started).toBe(1);
    expect(board.counts.closed).toBe(1);
  });

  it("orders a column by time in stage, longest first", async () => {
    const board = await loadBoard(db, filters(), "admin");
    const submittedColumn = board.columns.find((c) => c.stage.key === "submitted")!;
    expect(submittedColumn.cards[0]!.id).toBe(ids["Ida Waiting"]);
  });

  it("fills the card fields", async () => {
    const now = new Date();
    const board = await loadBoard(db, filters(), "admin", now);

    const ann = card(board, "Ann Submitted");
    expect(ann).toMatchObject({
      firstName: "Ann",
      status: "open",
      entryCode: "SNW26QR",
      sessionLabel: null,
      onHold: false,
      unhandledTexts: 0,
      returning: "none",
      temporary: false,
      daysInStage: 0,
      eventSeq: 2,
    });
    expect(ann.entryCodeLabel).toBeTruthy();
    expect(ann.submittedAt).toBeInstanceOf(Date);

    expect(card(board, "Ben Session").sessionLabel).toContain(`Plymouth shop ${TAG}`);
    expect(card(board, "Ben Session").entryCode).toBeNull();

    const cal = card(board, "Cal Reviewed");
    expect(cal).toMatchObject({ onHold: true, unhandledTexts: 1, stageId: stages.reviewed });

    const fay = card(board, "Fay Hired");
    expect(fay).toMatchObject({ status: "hired", temporary: true });

    expect(card(board, "Gus Returning").returning).toBe("not_rehire_eligible");
    expect(card(board, "Hal Returning").returning).toBe("returning");
    expect(card(board, "Ida Waiting").daysInStage).toBe(3);
  });

  it("carries the background checks for the Close dialog, but not for a Viewer", async () => {
    const staffBoard = await loadBoard(db, filters(), "hiring_manager");
    const checks = staffBoard.checks[ids["Kim Checked"]!]!;
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({ checkType: "driving_record", status: "requested", open: true });
    expect(staffBoard.checks[ids["Ann Submitted"]!]).toBeUndefined();

    const viewerBoard = await loadBoard(db, filters(), "viewer");
    expect(viewerBoard.checks).toEqual({});
    expect(allCards(viewerBoard)).toHaveLength(allCards(staffBoard).length);
  });
});

describe("filters", () => {
  it("parses the URL and writes it back", () => {
    const parsed = parseBoardFilters({ hold: "1", session: "none", code: ["abc"], q: "  Ann  ", stage: "ignored" }, openingId);
    expect(parsed).toEqual({ openingId, onHold: true, sessionId: "none", entryCodeId: "abc", search: "Ann" });
    const params = boardFilterParams(parsed);
    expect(params.get("opening")).toBe(openingId);
    expect(params.get("hold")).toBe("1");
    expect(params.get("q")).toBe("Ann");
    expect(boardFiltersActive(parsed)).toBe(true);
    expect(boardFiltersActive(parseBoardFilters({}, openingId))).toBe(false);
  });

  it("shows only cards on hold", async () => {
    expect(await names({ onHold: true })).toEqual([n("Cal Reviewed")]);
  });

  it("filters by group session", async () => {
    expect(await names({ sessionId })).toEqual([n("Ben Session")]);
    expect(await names({ sessionId: "none" })).not.toContain(n("Ben Session"));
    expect(await names({ sessionId: "none" })).toHaveLength(7);
  });

  it("filters by entry code", async () => {
    expect(await names({ entryCodeId: codeId })).toEqual([n("Ann Submitted")]);
    expect(await names({ entryCodeId: "none" })).toHaveLength(7);
  });

  it("searches by first, last or full name, never by contact details", async () => {
    expect(await names({ search: `reviewed${TAG}` })).toEqual([n("Cal Reviewed")]);
    expect(await names({ search: `ann submitted${TAG}` })).toEqual([n("Ann Submitted")]);
    expect(await names({ search: "+1612" })).toEqual([]);
    expect(await names({ search: "@example.test" })).toEqual([]);
    expect(await names({ search: `100%${TAG}` })).toEqual([]);
  });

  it("applies the filters to the header counts", async () => {
    const held = await loadBoard(db, filters({ onHold: true }), "admin");
    expect(held.counts).toEqual({ started: 0, closed: 0, offBoard: 0 });
    const dee = await loadBoard(db, filters({ search: `started${TAG}` }), "admin");
    expect(dee.counts.started).toBe(1);
    expect(allCards(dee)).toEqual([]);
  });
});

describe("moving a card", () => {
  it("moves a card into a plain stage with its version and records the actor", async () => {
    const before = card(await loadBoard(db, filters(), "admin"), "Hal Returning");
    const result = await moveBoardCard(db, { applicationId: before.id, expectedSeq: before.eventSeq, toStageId: stages.reviewed!, actor: staff });
    expect(result).toEqual({ applicationId: before.id, eventSeq: before.eventSeq + 1, stageId: stages.reviewed, status: "open" });
    const events = await db.select().from(applicationEvent).where(eq(applicationEvent.applicationId, before.id));
    const moved = events.find((e) => e.seq === result.eventSeq)!;
    expect(moved).toMatchObject({ kind: "stage_changed", fromStageId: stages.submitted, toStageId: stages.reviewed, actorType: "staff", actorUserId: adminId });
    expect(columnOf(await loadBoard(db, filters(), "admin"), "Hal Returning")).toBe("reviewed");
  });

  it("moves backward too", async () => {
    const hal = card(await loadBoard(db, filters(), "admin"), "Hal Returning");
    const result = await moveBoardCard(db, { applicationId: hal.id, expectedSeq: hal.eventSeq, toStageId: stages.submitted!, actor: staff });
    expect(result.stageId).toBe(stages.submitted);
  });

  it("refuses a stale version and says who changed it", async () => {
    const ben = card(await loadBoard(db, filters(), "admin"), "Ben Session");
    await transition(db, { action: "contacted", applicationId: ben.id, actor: staff, expectedSeq: ben.eventSeq });
    let caught: unknown;
    try {
      await moveBoardCard(db, { applicationId: ben.id, expectedSeq: ben.eventSeq, toStageId: stages.reviewed!, actor: staff });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(StaleVersionError);
    expect((caught as StaleVersionError).changedBy?.email).toBe(TEST_ADMIN_EMAIL);
    expect(columnOf(await loadBoard(db, filters(), "admin"), "Ben Session")).toBe("submitted");
  });

  it("sends Offer, Check and Hired to the Move dialog instead", async () => {
    const ann = card(await loadBoard(db, filters(), "admin"), "Ann Submitted");
    for (const key of ["conditional_offer", "background_check", "hired"]) {
      await expect(moveBoardCard(db, { applicationId: ann.id, expectedSeq: ann.eventSeq, toStageId: stages[key]!, actor: staff })).rejects.toMatchObject({
        code: "stage_not_allowed",
      });
    }
    await expect(moveBoardCard(db, { applicationId: ann.id, expectedSeq: ann.eventSeq, toStageId: uuidv7(), actor: staff })).rejects.toBeInstanceOf(TransitionError);
  });

  it("loads the hire record a move to Hired created, for the hire form", async () => {
    const [stint] = await db.select().from(hireStint).where(eq(hireStint.applicationId, ids["Fay Hired"]!));
    const loaded = await loadBoardStint(db, stint!.id);
    expect(loaded).toMatchObject({ id: stint!.id, isTemporary: true, outcome: "active", crewLabel: null, leaveReasonLabel: null });
    expect(await loadBoardStint(db, uuidv7())).toBeNull();
  });
});
