import type { Route } from "next";
import Link from "next/link";
import { pageAccess } from "@/components/admin/settings/page-access";
import { PicklistEditor } from "@/components/admin/settings/picklist-editor";
import { PageHeader } from "@/components/admin/page-header";
import { db } from "@/db";
import { cn } from "@/lib/utils";
import { isOptionReferenced, isPicklistKey, listPicklistOptions, PICKLISTS, type PicklistKey } from "@/server/services/config/picklists";
import { listRoles } from "@/server/services/config/stages";

export const metadata = { title: "Picklists" };

const DEFAULT_LIST: PicklistKey = "disqualify_reason";

// Settings > Picklists: every small staff-facing list in one place. Admin only.
export default async function PicklistsSettingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const access = await pageAccess("admin");
  const header = (
    <PageHeader
      title="Picklists"
      description="Add, relabel, archive or unarchive options. Crews are entered here. A key in use cannot change; archive it and add a new one."
    />
  );
  if (!access.ok) {
    return (
      <div>
        {header}
        {access.view}
      </div>
    );
  }

  const params = await searchParams;
  const requested = Array.isArray(params.list) ? params.list[0] : params.list;
  const listKey: PicklistKey = isPicklistKey(requested) ? requested : DEFAULT_LIST;
  const list = PICKLISTS.find((l) => l.key === listKey)!;

  const [allOptions, roles] = await Promise.all([listPicklistOptions(db), listRoles(db)]);
  const options = allOptions.filter((o) => o.listKey === listKey);
  const referenced = await Promise.all(options.map((o) => isOptionReferenced(db, o.id)));

  return (
    <div>
      {header}
      <div className="grid gap-6 lg:grid-cols-[14rem_1fr]">
        <nav className="flex gap-1 overflow-x-auto lg:flex-col" aria-label="Lists">
          {PICKLISTS.map((l) => {
            const count = allOptions.filter((o) => o.listKey === l.key && !o.archivedAt).length;
            return (
              <Link
                key={l.key}
                href={`/admin/settings/picklists?list=${l.key}` as Route}
                className={cn(
                  "flex shrink-0 items-center justify-between gap-3 rounded-md px-3 py-2 text-sm hover:bg-accent",
                  l.key === listKey && "bg-accent font-medium",
                )}
              >
                {l.label}
                <span className="text-xs text-muted-foreground">{count}</span>
              </Link>
            );
          })}
        </nav>
        <PicklistEditor
          list={list}
          roles={roles.map((r) => ({ id: r.id, name: r.internalName }))}
          options={options.map((o, i) => ({
            id: o.id,
            key: o.key,
            label: o.label,
            requiresNote: o.requiresNote,
            fcraAdverse: o.fcraAdverse,
            defaultSeparation: o.defaultSeparation,
            roleId: o.roleId,
            roleName: o.roleName,
            archivedAt: o.archivedAt,
            referenced: referenced[i] ?? false,
          }))}
        />
      </div>
    </div>
  );
}
