import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

// The application itself: short sections, every answer saved as it changes.
export default function ApplyPage() {
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight">Your application</h1>
      <Card>
        <CardHeader>
          <CardTitle>Basics</CardTitle>
          <CardDescription>Your answers save as you go. You can finish on any device.</CardDescription>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          The questions for this opening appear here once the form is built.
        </CardContent>
      </Card>
    </div>
  );
}
