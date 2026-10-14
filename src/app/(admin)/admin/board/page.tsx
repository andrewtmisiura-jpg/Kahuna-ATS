import { PageHeader } from "@/components/admin/page-header";

// Columns follow the seeded snow pipeline; Started is a count, not a column.
const columns = [
  "Submitted",
  "Reviewed",
  "One-on-one invited",
  "One-on-one done",
  "Conditional offer",
  "Background or driving check",
  "Hired",
];

export default function BoardPage() {
  return (
    <div>
      <PageHeader title="Board" description="Drag a card to move it. Every move is logged with your name." />
      <div className="flex gap-3 overflow-x-auto pb-4">
        {columns.map((column) => (
          <section key={column} className="w-64 shrink-0 rounded-lg border bg-muted/30 p-3">
            <h2 className="mb-3 text-sm font-medium">{column}</h2>
            <p className="text-xs text-muted-foreground">No cards</p>
          </section>
        ))}
      </div>
    </div>
  );
}
