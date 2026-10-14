"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { recordTheyAskedToStop, resendLink, setPersonDoNotContact, updatePersonContact } from "@/server/actions/admin/applications";
import type { Profile } from "@/server/services/applications/queries";
import { ActionNotice, CheckboxRow, Field } from "./fields";
import { formatMobile } from "./format";
import { Rows, Section } from "./section";
import { useAdminAction } from "./use-admin-action";

// Contact details with the audited edit dialog and the shared-phone flag,
// do-not-contact, "They asked me to stop", resend link and revoke link.

export function ContactSection({ profile }: { profile: Profile }) {
  const { person, application, texting } = profile;
  const [editing, setEditing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const { run, pending, failure } = useAdminAction();
  const canAct = profile.role !== "viewer";
  if (!canAct) return null;

  return (
    <Section
      title="Contact"
      action={
        <Button size="xs" variant="outline" onClick={() => setEditing(true)}>
          Edit
        </Button>
      }
    >
      <Rows
        items={[
          { label: "Mobile", value: person.mobile ? `${formatMobile(person.mobile)}${person.sharedMobile ? " (shared phone)" : ""}` : null },
          { label: "Email", value: person.email },
          { label: "Texts", value: texting?.suppression ? "Opted out" : texting?.optedIn ? "Opted in" : "No opt-in" },
          { label: "Do not contact", value: person.doNotContact ? "Yes, nothing is sent" : "No" },
        ]}
      />
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" variant="outline" disabled={pending} onClick={() => run(() => resendLink({ applicationId: application.id }), (r) => setNotice(linkNotice(r)))}>
          Resend link
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={() => {
            if (window.confirm("Revoke every link sent so far and send a fresh one?")) {
              run(() => resendLink({ applicationId: application.id, revokeFirst: true }), (r) => setNotice(`${r.revoked} link${r.revoked === 1 ? "" : "s"} revoked. ${linkNotice(r)}`));
            }
          }}
        >
          Revoke link
        </Button>
        {person.mobile && !texting?.suppression ? (
          <Button
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() => {
              if (window.confirm("Record that this person asked us to stop texting? Texts stop at once; messages fall back to email.")) {
                run(() => recordTheyAskedToStop({ applicationId: application.id }));
              }
            }}
          >
            They asked me to stop
          </Button>
        ) : null}
        <Button
          size="sm"
          variant={person.doNotContact ? "secondary" : "outline"}
          disabled={pending}
          onClick={() => run(() => setPersonDoNotContact({ personId: person.id, value: !person.doNotContact }))}
        >
          {person.doNotContact ? "Allow contact again" : "Do not contact"}
        </Button>
      </div>
      {notice ? <p className="mt-2 text-xs text-muted-foreground">{notice}</p> : null}
      <ActionNotice failure={failure} className="mt-2" />
      <ContactDialog open={editing} onOpenChange={setEditing} person={person} />
    </Section>
  );
}

function linkNotice(r: { sent: number; suppressed: number }): string {
  const parts = [];
  if (r.sent > 0) parts.push(`${r.sent} sent`);
  if (r.suppressed > 0) parts.push(`${r.suppressed} not sent (see the thread)`);
  return parts.length ? `Link: ${parts.join(", ")}.` : "Link queued; the sender picks it up within five minutes.";
}

function ContactDialog({ open, onOpenChange, person }: { open: boolean; onOpenChange: (open: boolean) => void; person: Profile["person"] }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>{open ? <ContactForm onOpenChange={onOpenChange} person={person} /> : null}</DialogContent>
    </Dialog>
  );
}

function ContactForm({ onOpenChange, person }: { onOpenChange: (open: boolean) => void; person: Profile["person"] }) {
  const [firstName, setFirstName] = useState(person.firstName);
  const [lastName, setLastName] = useState(person.lastName);
  const [mobile, setMobile] = useState(person.mobile ?? "");
  const [email, setEmail] = useState(person.email ?? "");
  const [sharedMobile, setSharedMobile] = useState(person.sharedMobile);
  const { run, pending, failure } = useAdminAction();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    run(
      () => updatePersonContact({ personId: person.id, firstName, lastName, mobile: mobile || null, email: email || null, sharedMobile }),
      () => onOpenChange(false),
    );
  }

  return (
    <form onSubmit={submit} className="grid gap-4">
      <DialogHeader>
        <DialogTitle>Edit contact details</DialogTitle>
        <DialogDescription>Recorded with your name. A new number has no text opt-in until the person opts in again.</DialogDescription>
      </DialogHeader>
      <div className="grid grid-cols-2 gap-3">
        <Field label="First name">
          <Input value={firstName} onChange={(e) => setFirstName(e.target.value)} required />
        </Field>
        <Field label="Last name">
          <Input value={lastName} onChange={(e) => setLastName(e.target.value)} required />
        </Field>
      </div>
      <Field label="Mobile">
        <Input type="tel" inputMode="tel" value={mobile} onChange={(e) => setMobile(e.target.value)} placeholder="(612) 555-0123" />
      </Field>
      <CheckboxRow label="Two people share this phone" hint="A shared number matches applicants by email only." checked={sharedMobile} onChange={setSharedMobile} />
      <Field label="Email">
        <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
      </Field>
      <ActionNotice failure={failure} />
      <DialogFooter>
        <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button type="submit" disabled={pending}>
          Save
        </Button>
      </DialogFooter>
    </form>
  );
}
