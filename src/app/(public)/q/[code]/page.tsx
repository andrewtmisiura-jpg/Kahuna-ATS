// Entry code resolver: every QR and shared link lands here. Stage 3 looks the code up,
// counts the scan and shows the role landing page (or the role page for a closed code).
export default async function EntryCodePage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  return (
    <div className="space-y-3">
      <h1 className="text-2xl font-semibold tracking-tight">Snow Removal Technician</h1>
      <p className="text-muted-foreground">
        The application for entry code <span className="font-mono">{code.toUpperCase()}</span> opens
        here once the landing page is built.
      </p>
    </div>
  );
}
