// Resume link target: the token arrives after "#", so it never reaches the server log.
// Stage 3 posts it once, sets the HttpOnly cookie and continues to /apply.
export default function ResumePage() {
  return (
    <div className="space-y-3">
      <h1 className="text-2xl font-semibold tracking-tight">Opening your application</h1>
      <p className="text-muted-foreground">One moment while we find your saved answers.</p>
    </div>
  );
}
