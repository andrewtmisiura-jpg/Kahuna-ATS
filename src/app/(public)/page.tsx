import Link from "next/link";
import { Button } from "@/components/ui/button";
import { HIRING_NUMBER } from "@/components/applicant/status-copy";

export default function HomePage() {
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight">Kahuna Window Cleaning is hiring</h1>
      <p className="text-muted-foreground">
        Applications open from the link in your Indeed message or the QR code shown at a group interview. Each
        link is personal and reopens your saved answers on any device.
      </p>
      <Button asChild variant="outline" className="h-12 w-full">
        <Link href="/lost-link">Lost your application link?</Link>
      </Button>
      <p className="text-sm text-muted-foreground">Questions? Call or text {HIRING_NUMBER}.</p>
    </div>
  );
}
