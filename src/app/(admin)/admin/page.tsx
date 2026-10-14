import { PageHeader } from "@/components/admin/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

const counts = [
  { label: "Started", value: 0 },
  { label: "In progress", value: 0 },
  { label: "Submitted", value: 0 },
];

export default function ApplicantListPage() {
  return (
    <div>
      <PageHeader title="Snow Removal 2026-27" description="Applicants, newest first.">
        <Badge variant="outline">Unhandled texts (0)</Badge>
      </PageHeader>
      <div className="mb-6 grid grid-cols-3 gap-3">
        {counts.map((count) => (
          <Card key={count.label}>
            <CardHeader>
              <CardTitle className="text-xs font-medium text-muted-foreground">{count.label}</CardTitle>
            </CardHeader>
            <CardContent className="text-2xl font-semibold">{count.value}</CardContent>
          </Card>
        ))}
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Stage</TableHead>
            <TableHead className="hidden md:table-cell">Source</TableHead>
            <TableHead className="hidden md:table-cell">Submitted</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow>
            <TableCell colSpan={4} className="py-10 text-center text-muted-foreground">
              No applications yet.
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>
    </div>
  );
}
