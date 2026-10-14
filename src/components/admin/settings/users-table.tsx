"use client";

import { UserPlus } from "lucide-react";
import { useRouter } from "next/navigation";
import * as React from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { addUserAction, changeUserRoleAction, disableUserAction, enableUserAction } from "@/server/actions/admin/settings";
import { Field, NativeSelect, Notice } from "./fields";
import { formatCentralDateTime } from "./format";

export type UserListItem = {
  id: string;
  email: string;
  name: string | null;
  role: "admin" | "hiring_manager" | "viewer";
  status: "active" | "disabled";
  lastSignInAt: Date | null;
  googleSub: string | null;
};

const ROLE_LABEL: Record<UserListItem["role"], string> = { admin: "Admin", hiring_manager: "Hiring Manager", viewer: "Viewer" };

export function UsersTable({ users, currentUserId }: { users: UserListItem[]; currentUserId: string }) {
  const router = useRouter();
  const [adding, setAdding] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [pending, startTransition] = React.useTransition();

  function act(fn: () => Promise<{ ok: boolean; error?: string }>) {
    startTransition(async () => {
      setError(null);
      const result = await fn();
      if (!result.ok) {
        setError(result.error ?? "Something went wrong");
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button size="sm" onClick={() => setAdding(true)}>
          <UserPlus />
          Add user
        </Button>
      </div>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Email</TableHead>
            <TableHead>Role</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="hidden md:table-cell">Last sign-in</TableHead>
            <TableHead className="w-32" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {users.map((user) => {
            const isSelf = user.id === currentUserId;
            return (
              <TableRow key={user.id} className={user.status === "disabled" ? "text-muted-foreground" : undefined}>
                <TableCell>
                  <div className="font-medium">{user.email}</div>
                  <div className="text-xs text-muted-foreground">
                    {user.name ?? ""}
                    {isSelf ? " (you)" : ""}
                  </div>
                </TableCell>
                <TableCell>
                  {user.role === "viewer" ? (
                    ROLE_LABEL.viewer
                  ) : (
                    <NativeSelect
                      aria-label={`Role for ${user.email}`}
                      className="h-8 w-40"
                      value={user.role}
                      disabled={pending || isSelf || user.status === "disabled"}
                      title={isSelf ? "Ask another Admin to change your role" : undefined}
                      onChange={(event) => act(() => changeUserRoleAction({ userId: user.id, role: event.target.value }))}
                    >
                      <option value="admin">Admin</option>
                      <option value="hiring_manager">Hiring Manager</option>
                    </NativeSelect>
                  )}
                </TableCell>
                <TableCell>
                  <Badge variant={user.status === "active" ? "secondary" : "outline"}>{user.status === "active" ? "Active" : "Disabled"}</Badge>
                </TableCell>
                <TableCell className="hidden md:table-cell">
                  {user.lastSignInAt ? formatCentralDateTime(user.lastSignInAt) : user.googleSub ? "" : "Not yet signed in"}
                </TableCell>
                <TableCell className="text-right">
                  {user.status === "active" ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={pending || isSelf}
                      title={isSelf ? "You cannot disable your own account" : "Ends their sessions at once"}
                      onClick={() => {
                        if (window.confirm(`Disable ${user.email}? They are signed out at once and cannot sign in again until re-enabled.`)) {
                          act(() => disableUserAction({ userId: user.id }));
                        }
                      }}
                    >
                      Disable
                    </Button>
                  ) : (
                    <Button size="sm" variant="outline" disabled={pending} onClick={() => act(() => enableUserAction({ userId: user.id }))}>
                      Re-enable
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      {adding ? <AddUserDialog onClose={() => setAdding(false)} /> : null}
    </div>
  );
}

function AddUserDialog({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    startTransition(async () => {
      setError(null);
      const result = await addUserAction({ email: String(form.get("email") ?? ""), role: String(form.get("role") ?? "") });
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
          <DialogTitle>Add a user</DialogTitle>
          <DialogDescription>They sign in with Google using this exact email. Personal Gmail is fine.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="grid gap-4">
          <Field label="Email" htmlFor="email">
            <Input id="email" name="email" type="email" required autoComplete="off" autoFocus />
          </Field>
          <Field label="Role" htmlFor="role" hint="Hiring Managers review applicants, run sessions and make codes. Admins also change Settings and export CSV.">
            <NativeSelect id="role" name="role" defaultValue="hiring_manager">
              <option value="hiring_manager">Hiring Manager</option>
              <option value="admin">Admin</option>
            </NativeSelect>
          </Field>
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
