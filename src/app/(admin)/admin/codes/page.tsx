import { PageHeader } from "@/components/admin/page-header";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export default function EntryCodesPage() {
  return (
    <div>
      <PageHeader title="Entry codes" description="Every printed QR or shared link. Close a code instead of reprinting.">
        <Button size="sm" disabled>New code</Button>
      </PageHeader>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Code</TableHead>
            <TableHead>Label</TableHead>
            <TableHead>Channel</TableHead>
            <TableHead>Scans today</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow>
            <TableCell colSpan={4} className="py-10 text-center text-muted-foreground">No codes yet.</TableCell>
          </TableRow>
        </TableBody>
      </Table>
    </div>
  );
}
