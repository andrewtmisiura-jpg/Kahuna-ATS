"use client";

import { Archive, ArchiveRestore, Pencil, Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import * as React from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  addPicklistOptionAction,
  archivePicklistOptionAction,
  unarchivePicklistOptionAction,
  updatePicklistOptionAction,
} from "@/server/actions/admin/settings";
import { CheckboxField, Field, NativeSelect, Notice } from "./fields";

export type PicklistListInfo = { key: string; label: string; description: string };

export type PicklistOptionItem = {
  id: string;
  key: string;
  label: string;
  requiresNote: boolean;
  fcraAdverse: boolean;
  defaultSeparation: "voluntary" | "involuntary" | null;
  roleId: string | null;
  roleName: string | null;
  archivedAt: Date | null;
  // True once an application, event or hire points at it: key, list, scope and the FCRA flag are then locked.
  referenced: boolean;
};

type RoleOption = { id: string; name: string };

export function PicklistEditor({ list, options, roles }: { list: PicklistListInfo; options: PicklistOptionItem[]; roles: RoleOption[] }) {
  const router = useRouter();
  const [adding, setAdding] = React.useState(false);
  const [editing, setEditing] = React.useState<PicklistOptionItem | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [pending, startTransition] = React.useTransition();
  const live = options.filter((o) => !o.archivedAt);
  const archived = options.filter((o) => o.archivedAt);

  function toggleArchived(option: PicklistOptionItem) {
    startTransition(async () => {
      setError(null);
      const result = option.archivedAt
        ? await unarchivePicklistOptionAction({ id: option.id })
        : await archivePicklistOptionAction({ id: option.id });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">{list.label}</h2>
          <p className="text-sm text-muted-foreground">{list.description}</p>
        </div>
        <Button size="sm" onClick={() => setAdding(true)}>
          <Plus />
          Add option
        </Button>
      </div>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <OptionsTable
        list={list}
        options={live}
        pending={pending}
        emptyText={list.key === "crew" ? "No crews yet. Add each crew here before the first hire." : "No options yet."}
        onEdit={setEditing}
        onToggleArchived={toggleArchived}
      />
      {archived.length > 0 ? (
        <details className="rounded-md border p-3">
          <summary className="cursor-pointer text-sm font-medium">Archived ({archived.length})</summary>
          <div className="mt-3">
            <OptionsTable list={list} options={archived} pending={pending} emptyText="" onEdit={setEditing} onToggleArchived={toggleArchived} />
          </div>
        </details>
      ) : null}
      {adding ? <AddOptionDialog list={list} roles={roles} onClose={() => setAdding(false)} /> : null}
      {editing ? <EditOptionDialog list={list} option={editing} onClose={() => setEditing(null)} /> : null}
    </div>
  );
}

function OptionsTable({
  list,
  options,
  pending,
  emptyText,
  onEdit,
  onToggleArchived,
}: {
  list: PicklistListInfo;
  options: PicklistOptionItem[];
  pending: boolean;
  emptyText: string;
  onEdit: (option: PicklistOptionItem) => void;
  onToggleArchived: (option: PicklistOptionItem) => void;
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Label</TableHead>
          <TableHead className="hidden md:table-cell">Key</TableHead>
          <TableHead className="hidden md:table-cell">Applies to</TableHead>
          <TableHead>Flags</TableHead>
          <TableHead className="w-44" />
        </TableRow>
      </TableHeader>
      <TableBody>
        {options.length === 0 ? (
          <TableRow>
            <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">
              {emptyText}
            </TableCell>
          </TableRow>
        ) : null}
        {options.map((option) => (
          <TableRow key={option.id} className={option.archivedAt ? "text-muted-foreground" : undefined}>
            <TableCell className="font-medium">
              {option.label}
              <div className="font-mono text-xs text-muted-foreground md:hidden">{option.key}</div>
            </TableCell>
            <TableCell className="hidden font-mono text-xs md:table-cell">{option.key}</TableCell>
            <TableCell className="hidden md:table-cell">{option.roleName ?? "All roles"}</TableCell>
            <TableCell>
              <div className="flex flex-wrap gap-1">
                {option.requiresNote ? <Badge variant="outline">Note required</Badge> : null}
                {option.fcraAdverse ? <Badge variant="destructive">Background-based</Badge> : null}
                {option.defaultSeparation ? <Badge variant="secondary">{option.defaultSeparation === "voluntary" ? "Voluntary" : "Involuntary"}</Badge> : null}
                {option.referenced ? <Badge variant="outline">In use</Badge> : null}
              </div>
            </TableCell>
            <TableCell className="text-right">
              <div className="flex justify-end gap-1">
                <Button size="sm" variant="outline" onClick={() => onEdit(option)} disabled={pending}>
                  <Pencil />
                  Edit
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => onToggleArchived(option)}
                  disabled={pending}
                  title={option.archivedAt ? "Offer this option again" : `Hide it from the ${list.label.toLowerCase()} list; past records keep it`}
                >
                  {option.archivedAt ? <ArchiveRestore /> : <Archive />}
                  {option.archivedAt ? "Unarchive" : "Archive"}
                </Button>
              </div>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function slugify(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/^[^a-z]+/, "")
    .slice(0, 40);
}

function AddOptionDialog({ list, roles, onClose }: { list: PicklistListInfo; roles: RoleOption[]; onClose: () => void }) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);
  const [key, setKey] = React.useState("");
  const [keyTouched, setKeyTouched] = React.useState(false);

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const separation = String(form.get("defaultSeparation") ?? "");
    startTransition(async () => {
      setError(null);
      const result = await addPicklistOptionAction({
        listKey: list.key,
        roleId: String(form.get("roleId") ?? "") || null,
        key: String(form.get("key") ?? ""),
        label: String(form.get("label") ?? ""),
        requiresNote: form.get("requiresNote") === "on",
        fcraAdverse: form.get("fcraAdverse") === "on",
        defaultSeparation: separation === "voluntary" || separation === "involuntary" ? separation : null,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
      onClose();
    });
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add to {list.label.toLowerCase()}</DialogTitle>
          <DialogDescription>The label is what staff see. The key is what reports group by and cannot change once the option is used.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="grid gap-4">
          <Field label="Label" htmlFor="label">
            <Input
              id="label"
              name="label"
              required
              autoFocus
              onChange={(event) => {
                if (!keyTouched) setKey(slugify(event.target.value));
              }}
            />
          </Field>
          <Field label="Key" htmlFor="key" hint="Lowercase letters, digits and underscores.">
            <Input
              id="key"
              name="key"
              required
              value={key}
              className="font-mono"
              onChange={(event) => {
                setKeyTouched(true);
                setKey(event.target.value);
              }}
            />
          </Field>
          <Field label="Applies to" htmlFor="roleId">
            <NativeSelect id="roleId" name="roleId" defaultValue="">
              <option value="">All roles</option>
              {roles.map((role) => (
                <option key={role.id} value={role.id}>
                  {role.name}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <OptionFlags list={list} />
          {error ? <Notice tone="error">{error}</Notice> : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? "Adding" : "Add"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function OptionFlags({
  list,
  option,
  lockFcra,
}: {
  list: PicklistListInfo;
  option?: PicklistOptionItem;
  lockFcra?: boolean;
}) {
  return (
    <>
      <CheckboxField name="requiresNote" label="A note is required when staff pick this" defaultChecked={option?.requiresNote ?? false} />
      {list.key === "disqualify_reason" ? (
        <CheckboxField
          name="fcraAdverse"
          label="Background-based reason (FCRA)"
          defaultChecked={option?.fcraAdverse ?? false}
          disabled={lockFcra}
          hint={
            lockFcra
              ? "Locked: this option is already used on a record. Archive it and add a new one to change this."
              : "Closing with this reason must name the background check and wait 5 weekdays after its pre-adverse notice."
          }
        />
      ) : null}
      {list.key === "leave_reason" ? (
        <Field label="Usual separation type" htmlFor="defaultSeparation" hint="Pre-filled on the hire form; staff can change it.">
          <NativeSelect id="defaultSeparation" name="defaultSeparation" defaultValue={option?.defaultSeparation ?? ""}>
            <option value="">Staff choose</option>
            <option value="voluntary">Voluntary</option>
            <option value="involuntary">Involuntary</option>
          </NativeSelect>
        </Field>
      ) : null}
    </>
  );
}

function EditOptionDialog({ list, option, onClose }: { list: PicklistListInfo; option: PicklistOptionItem; onClose: () => void }) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const separation = String(form.get("defaultSeparation") ?? "");
    startTransition(async () => {
      setError(null);
      const result = await updatePicklistOptionAction({
        id: option.id,
        patch: {
          label: String(form.get("label") ?? ""),
          requiresNote: form.get("requiresNote") === "on",
          ...(option.referenced
            ? {}
            : {
                key: String(form.get("key") ?? ""),
                fcraAdverse: list.key === "disqualify_reason" ? form.get("fcraAdverse") === "on" : false,
              }),
          ...(list.key === "leave_reason"
            ? { defaultSeparation: separation === "voluntary" || separation === "involuntary" ? separation : null }
            : {}),
        },
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
      onClose();
    });
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit option</DialogTitle>
          <DialogDescription>
            {option.referenced
              ? "This option is already used on applications or hires, so its key and background flag are locked. Relabel it, or archive it and add a new one."
              : "Nothing uses this option yet, so everything can still change."}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="grid gap-4">
          <Field label="Label" htmlFor="edit-label">
            <Input id="edit-label" name="label" required defaultValue={option.label} autoFocus />
          </Field>
          <Field label="Key" htmlFor="edit-key" hint={option.referenced ? "Locked while in use." : "Lowercase letters, digits and underscores."}>
            <Input id="edit-key" name="key" defaultValue={option.key} className="font-mono" disabled={option.referenced} />
          </Field>
          <OptionFlags list={list} option={option} lockFcra={option.referenced} />
          {error ? <Notice tone="error">{error}</Notice> : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
