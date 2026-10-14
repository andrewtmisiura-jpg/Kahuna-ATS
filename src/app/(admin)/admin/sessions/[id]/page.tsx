import { ChevronLeft } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { formatCentralDateTime, fullName } from "@/components/admin/settings/format";
import { Notice } from "@/components/admin/settings/fields";
import { pageAccess } from "@/components/admin/settings/page-access";
import { QrCard } from "@/components/admin/settings/qr-card";
import { SessionEditButton } from "@/components/admin/sessions/session-edit-button";
import { SessionStatusBadge } from "@/components/admin/sessions/sessions-table";
import { PageHeader } from "@/components/admin/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { db } from "@/db";
import { getEmployer } from "@/server/services/config/employer";
import { getSession, listSessionOpenings } from "@/server/services/config/sessions";

export const metadata = { title: "Group session" };

// One session: its details, its QR, the code's scan counts and the applicants
// attributed to it. Admins and Hiring Managers.
export default async function SessionPage({ params }: { params: Promise<{ id: string }> }) {
  const access = await pageAccess(["admin", "hiring_manager"]);
  if (!access.ok) return access.view;
  const { id } = await params;
  const [session, openings, employer] = await Promise.all([getSession(db, id), listSessionOpenings(db), getEmployer(db)]);
  if (!session) notFound();

  const details: [string, React.ReactNode][] = [
    ["Opening", session.openingName],
    ["Location", session.locationAddress ? `${session.locationName}, ${session.locationAddress}` : session.locationName],
    ["Invited", session.invitedCount ?? "Not entered"],
    ["Attended", session.attendedCount ?? "Not entered yet"],
    ["Notes", session.notes ?? ""],
  ];

  return (
    <div className="space-y-6">
      <div>
        <Button asChild variant="ghost" size="sm" className="-ml-2 mb-2">
          <Link href="/admin/sessions">
            <ChevronLeft />
            Sessions
          </Link>
        </Button>
        <PageHeader title={formatCentralDateTime(session.startsAt)} description={`${session.locationName}. ${session.roleName}.`}>
          <div className="flex items-center gap-2">
            <SessionStatusBadge status={session.status} />
            <SessionEditButton
              openings={openings.map((o) => ({ id: o.id, name: o.name, roleName: o.roleName, status: o.status }))}
              session={{
                id: session.id,
                openingId: session.openingId,
                startsAt: session.startsAt,
                locationName: session.locationName,
                locationAddress: session.locationAddress,
                invitedCount: session.invitedCount,
                attendedCount: session.attendedCount,
                notes: session.notes,
                status: session.status,
                hasApplicants: session.startedCount > 0,
              }}
            />
          </div>
        </PageHeader>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Details</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid gap-2 text-sm">
              {details.map(([label, value]) => (
                <div key={label} className="grid grid-cols-[6rem_1fr] gap-2">
                  <dt className="text-muted-foreground">{label}</dt>
                  <dd className="whitespace-pre-wrap">{value}</dd>
                </div>
              ))}
            </dl>
          </CardContent>
        </Card>

        {session.code ? (
          <QrCard
            code={session.code}
            hiringHost={employer.hiringHost}
            title="Session QR code"
            description="Show it on a slide or print it. Applicants who scan it are attributed to this session."
            scansToday={session.scansToday}
            scansTotal={session.scansTotal}
          />
        ) : (
          <Card>
            <CardHeader>
              <CardTitle>Session QR code</CardTitle>
            </CardHeader>
            <CardContent>
              <Notice tone="warning">
                This session has no code of its own. Create one under Entry codes with the channel Group session QR code and this session selected.
              </Notice>
            </CardContent>
          </Card>
        )}
      </div>

      {session.codes.length > 1 ? (
        <p className="text-xs text-muted-foreground">
          {session.codes.length} codes point at this session; scan counts above cover all of them. Manage them under Entry codes.
        </p>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Applicants from this session</CardTitle>
          <CardDescription>
            <span className="font-medium text-foreground">{session.startedCount}</span> started,{" "}
            <span className="font-medium text-foreground">{session.submittedCount}</span> submitted. Attendee names from the sign-up sheet and
            stars arrive Nov 6.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {session.applicants.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nobody has scanned this session&apos;s code yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Stage</TableHead>
                  <TableHead className="hidden sm:table-cell">Started</TableHead>
                  <TableHead>Submitted</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {session.applicants.map((a) => (
                  <TableRow key={a.applicationId}>
                    <TableCell>
                      <Link href={`/admin/applicants/${a.applicationId}`} className="font-medium underline-offset-4 hover:underline">
                        {fullName(a.firstName, a.lastName)}
                      </Link>
                    </TableCell>
                    <TableCell>
                      {a.stageName}
                      {a.status !== "open" ? <span className="text-muted-foreground"> ({a.status})</span> : null}
                    </TableCell>
                    <TableCell className="hidden sm:table-cell">{formatCentralDateTime(a.startedAt)}</TableCell>
                    <TableCell>{a.submittedAt ? formatCentralDateTime(a.submittedAt) : <span className="text-muted-foreground">Not yet</span>}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
