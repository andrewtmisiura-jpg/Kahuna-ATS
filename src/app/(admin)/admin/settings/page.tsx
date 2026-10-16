import type { Route } from "next";
import Link from "next/link";
import { PageHeader } from "@/components/admin/page-header";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

const screens: { href: Route; title: string; description: string }[] = [
  { href: "/admin/settings/openings", title: "Openings", description: "Status, dates, pay, benefits and headcount per season." },
  { href: "/admin/settings/users", title: "Users", description: "Who can sign in, with a role each. Disable to offboard." },
  { href: "/admin/settings/texting", title: "Texting", description: "On or off, help contact and the daily cap." },
  { href: "/admin/codes", title: "Entry codes", description: "Create, close and download QR codes." },
  { href: "/admin/settings/picklists", title: "Picklists", description: "Reasons and crews." },
  { href: "/admin/settings/roles", title: "Roles and stages", description: "A new role from a template, and each role's stages." },
  { href: "/admin/settings/templates", title: "Message templates", description: "The wording of every text and email, and the booking link." },
  { href: "/admin/settings/scoring", title: "AI scoring", description: "Rubrics, Try it, the scoring mode per role and the AI disclosure." },
];

export default function SettingsPage() {
  return (
    <div>
      <PageHeader title="Settings" />
      <div className="grid gap-3 md:grid-cols-2">
        {screens.map((screen) => (
          <Link key={screen.href} href={screen.href}>
            <Card className="h-full hover:bg-accent/40">
              <CardHeader>
                <CardTitle>{screen.title}</CardTitle>
                <CardDescription>{screen.description}</CardDescription>
              </CardHeader>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
