import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export const metadata = { title: "Lost your link?" };

// Stage 3 wires this form: Turnstile check, then a fresh link to the details on file.
export default function LostLinkPage() {
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight">Lost your application link?</h1>
      <p className="text-muted-foreground">
        Enter the mobile number or email you applied with and we will send your link again.
      </p>
      <form className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="contact">Mobile number or email</Label>
          <Input id="contact" name="contact" inputMode="email" autoComplete="email" disabled />
        </div>
        <Button type="submit" className="w-full" disabled>
          Send my link
        </Button>
      </form>
    </div>
  );
}
