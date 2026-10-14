import { PageHeader } from "@/components/admin/page-header";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export default function SessionsPage() {
  return (
    <div>
      <PageHeader title="Group sessions" description="Each session gets its own QR code and shows on the applicants who scanned it.">
        <Button size="sm" disabled>New session</Button>
      </PageHeader>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Date</TableHead>
            <TableHead>Location</TableHead>
            <TableHead>Invited</TableHead>
            <TableHead>Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow>
            <TableCell colSpan={4} className="py-10 text-center text-muted-foreground">No sessions yet.</TableCell>
          </TableRow>
        </TableBody>
      </Table>
    </div>
  );
}
