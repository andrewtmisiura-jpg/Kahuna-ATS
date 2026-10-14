"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { saveOffer } from "@/server/actions/admin/applications";
import type { ProfileCheck, ProfileOffer } from "@/server/services/applications/queries";
import { ActionNotice, CheckboxRow, Field, NativeSelect, Textarea, YesNo } from "./fields";
import { formatCalendarDate, OFFER_RESPONSE_LABELS } from "./format";
import { Empty, Section } from "./section";
import { useAdminAction } from "./use-admin-action";

// The offer panel: the offer date is read-only (it comes from the stage move);
// the rest is editable, and a rescission while a check is open needs the FCRA statement.

export function OfferPanel({ offers, checks, canAct }: { offers: ProfileOffer[]; checks: ProfileCheck[]; canAct: boolean }) {
  return (
    <Section title="Offer">
      {offers.length === 0 ? <Empty>No offer yet. Moving to Conditional offer creates one.</Empty> : null}
      <div className="grid gap-4">
        {offers.map((offer, index) => (
          <OfferForm key={offer.id} offer={offer} openChecks={checks.filter((c) => c.open)} canAct={canAct} current={index === 0} />
        ))}
      </div>
    </Section>
  );
}

function OfferForm({ offer, openChecks, canAct, current }: { offer: ProfileOffer; openChecks: ProfileCheck[]; canAct: boolean; current: boolean }) {
  const [isConditional, setIsConditional] = useState(offer.isConditional);
  const [plannedStartOn, setPlannedStartOn] = useState(offer.plannedStartOn ?? "");
  const [payAmount, setPayAmount] = useState(offer.payAmount ?? "");
  const [payUnit, setPayUnit] = useState(offer.payUnit ?? "hourly");
  const [response, setResponse] = useState(offer.response);
  const [respondedOn, setRespondedOn] = useState(offer.respondedOn ?? "");
  const [note, setNote] = useState(offer.note ?? "");
  const [notReportBased, setNotReportBased] = useState(false);
  const { run, pending, failure } = useAdminAction();
  const rescinding = response === "rescinded" && offer.response !== "rescinded" && openChecks.length > 0;

  function submit(e: React.FormEvent) {
    e.preventDefault();
    run(() =>
      saveOffer({
        offerId: offer.id,
        patch: {
          isConditional,
          plannedStartOn: plannedStartOn || null,
          payAmount: payAmount || null,
          payUnit: payAmount ? payUnit : null,
          response,
          respondedOn: respondedOn || null,
          note: note || null,
          notReportBased: rescinding ? notReportBased : undefined,
        },
      }),
    );
  }

  return (
    <form onSubmit={submit} className={`grid gap-3 ${current ? "" : "opacity-80"}`}>
      <p className="text-sm">
        Offered {formatCalendarDate(offer.offeredOn)}
        {offer.offeredByName ? ` by ${offer.offeredByName}` : ""}
        {current ? "" : " (earlier offer)"}
        <span className="block text-xs text-muted-foreground">The offer date comes from the stage move. To correct it, void the move and enter it again.</span>
      </p>
      {canAct ? (
        <>
          <Field label="Conditional offer?" group>
            <YesNo name={`conditional-${offer.id}`} value={isConditional} onChange={setIsConditional} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Planned start">
              <Input type="date" value={plannedStartOn} onChange={(e) => setPlannedStartOn(e.target.value)} />
            </Field>
            <Field label="Pay" group>
              <div className="flex gap-1">
                <Input inputMode="decimal" placeholder="22.50" value={payAmount} onChange={(e) => setPayAmount(e.target.value)} />
                <NativeSelect className="w-auto" value={payUnit} onChange={(e) => setPayUnit(e.target.value as typeof payUnit)}>
                  <option value="hourly">/hr</option>
                  <option value="daily">/day</option>
                  <option value="salary">salary</option>
                </NativeSelect>
              </div>
            </Field>
            <Field label="Response">
              <NativeSelect value={response} onChange={(e) => setResponse(e.target.value as typeof response)}>
                {Object.entries(OFFER_RESPONSE_LABELS).map(([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Field label="Response date">
              <Input type="date" value={respondedOn} onChange={(e) => setRespondedOn(e.target.value)} />
            </Field>
          </div>
          {rescinding ? (
            <CheckboxRow
              label="This decision does not rely on the background report."
              hint="A background check is open. To rescind because of the report, close the application with a background-based reason instead."
              checked={notReportBased}
              onChange={setNotReportBased}
            />
          ) : null}
          <Field label="Note">
            <Textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} className="min-h-14" />
          </Field>
          <ActionNotice failure={failure} />
          <div>
            <Button type="submit" size="sm" disabled={pending || (rescinding && !notReportBased)}>
              Save offer
            </Button>
          </div>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">
          {isConditional ? "Conditional" : "Not conditional"}, {OFFER_RESPONSE_LABELS[response]}
          {plannedStartOn ? `, planned start ${formatCalendarDate(plannedStartOn)}` : ""}
        </p>
      )}
    </form>
  );
}
