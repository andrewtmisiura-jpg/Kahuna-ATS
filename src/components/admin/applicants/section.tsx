import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

// One profile section: a card with a small title and an optional right-hand slot.
export function Section({
  title,
  action,
  children,
  className,
  id,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  id?: string;
}) {
  return (
    <Card id={id} className={cn("gap-3 py-4", className)}>
      <CardHeader className="px-4">
        <CardTitle className="flex items-center justify-between gap-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          <span>{title}</span>
          {action}
        </CardTitle>
      </CardHeader>
      <CardContent className="px-4 text-sm">{children}</CardContent>
    </Card>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-muted-foreground">{children}</p>;
}

export function Rows({ items }: { items: { label: string; value: React.ReactNode }[] }) {
  return (
    <dl className="grid grid-cols-[minmax(7rem,auto)_1fr] gap-x-3 gap-y-1.5 text-sm">
      {items.map((item) => (
        <div key={item.label} className="contents">
          <dt className="text-muted-foreground">{item.label}</dt>
          <dd className="min-w-0 break-words">{item.value ?? <span className="text-muted-foreground">none</span>}</dd>
        </div>
      ))}
    </dl>
  );
}
