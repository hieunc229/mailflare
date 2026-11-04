"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AtSign, Save, Trash2, UserPlus } from "@/components/icons";
import { useParams, usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useLanguage } from "@/components/language-provider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  createMailboxAlias,
  deleteMailbox,
  deleteMailboxAlias,
  fetchMailbox,
  fetchMailboxAliases,
  fetchSharedInboxAccess,
  getMailboxAddress,
  grantSharedInboxAccess,
  revokeSharedInboxAccess,
  updateMailboxSettings,
} from "./utils";
import { getMailboxesBase } from "../utils";
import MailboxAvatarForm from "./MailboxAvatarForm";

export default function MailboxSettingsPage() {
  const { t } = useLanguage();
  const params = useParams<{ id: string }>();
  const mailboxId = params.id;
  const qc = useQueryClient();
  const [displayName, setDisplayName] = useState("");
  const [useAllDomains, setUseAllDomains] = useState(true);
  const [selectedUserId, setSelectedUserId] = useState("");
  const [aliasLocalPart, setAliasLocalPart] = useState("");
  const [aliasDomainId, setAliasDomainId] = useState("");

  const mailbox = useQuery({
    queryKey: ["mailbox", mailboxId],
    queryFn: () => fetchMailbox(mailboxId),
    enabled: !!mailboxId,
  });

  useEffect(() => {
    if (mailbox.data) {
      setDisplayName(mailbox.data.displayName ?? "");
      setUseAllDomains(mailbox.data.useAllDomains);
      setAliasDomainId((current) => current || mailbox.data.domainId);
    }
  }, [mailbox.data]);

  const updateName = useMutation({
    mutationFn: () => updateMailboxSettings(mailboxId, { displayName, useAllDomains }),
    onSuccess: (updatedMailbox) => {
      qc.setQueryData(["mailbox", mailboxId], updatedMailbox);
      qc.invalidateQueries({ queryKey: ["mailboxes"] });
    },
  });

  const router = useRouter();
  const base = getMailboxesBase(usePathname());
  const removeMailbox = useMutation({
    mutationFn: () => deleteMailbox(mailboxId),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["mailboxes"] });
      router.push(base);
    },
  });

  const aliases = useQuery({
    queryKey: ["mailbox", mailboxId, "aliases"],
    queryFn: () => fetchMailboxAliases(mailboxId),
    enabled: !!mailboxId,
  });
  const addAlias = useMutation({
    mutationFn: () =>
      createMailboxAlias(mailboxId, {
        domainId: aliasDomainId,
        localPart: aliasLocalPart.trim(),
      }),
    onSuccess: async () => {
      setAliasLocalPart("");
      await qc.invalidateQueries({ queryKey: ["mailbox", mailboxId, "aliases"] });
    },
  });
  const removeAlias = useMutation({
    mutationFn: (aliasId: string) => deleteMailboxAlias(mailboxId, aliasId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["mailbox", mailboxId, "aliases"] }),
  });

  const sharedAccess = useQuery({
    queryKey: ["mailbox", mailboxId, "access"],
    queryFn: () => fetchSharedInboxAccess(mailboxId),
    enabled: mailbox.data?.canManageSharing === true,
  });
  const addMember = useMutation({
    mutationFn: () => grantSharedInboxAccess(mailboxId, selectedUserId),
    onSuccess: async () => {
      setSelectedUserId("");
      await qc.invalidateQueries({ queryKey: ["mailbox", mailboxId, "access"] });
    },
  });
  const removeMember = useMutation({
    mutationFn: (userId: string) => revokeSharedInboxAccess(mailboxId, userId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["mailbox", mailboxId, "access"] }),
  });

  const address = mailbox.data ? getMailboxAddress(mailbox.data) : "";

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="truncate text-2xl md:text-3xl font-medium text-neutral-900">
            {t("mailbox.title")}
          </h1>
          {address ? (
            <p className="mt-1 truncate no-font-mono text-sm text-neutral-500">
              {address}
            </p>
          ) : (
            <Skeleton className="mt-2 h-4 w-52" />
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {mailbox.data?.type === "shared" && (
            <Badge variant="secondary">{t("mailboxes.shared")}</Badge>
          )}
          {mailbox.data?.isPrimary && (
            <Badge variant="secondary">{t("mailbox.primary")}</Badge>
          )}
        </div>
      </div>

      {mailbox.isError && (
        <p className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {mailbox.error instanceof Error
            ? mailbox.error.message
            : t("mailbox.loadFailed")}
        </p>
      )}

      <Card className="rounded-3xl border-0 bg-white p-6">
        <CardHeader className="py-0">
          <CardTitle>{t("mailbox.account")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 pt-5">
          {mailbox.data ? (
            <MailboxAvatarForm
              mailboxId={mailbox.data.id}
              hasAvatar={!!mailbox.data.hasAvatar}
              name={mailbox.data.displayName || mailbox.data.localPart}
            />
          ) : (
            <Skeleton className="h-24 w-24 rounded-full" />
          )}

          <div className="space-y-2">
            <Label htmlFor="displayName">{t("common.name")}</Label>
            <Input
              id="displayName"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              placeholder={mailbox.data?.localPart ?? t("mailboxes.namePlaceholder")}
              disabled={mailbox.isLoading || updateName.isPending}
            />
          </div>
          <label className="flex items-start gap-3 rounded-xl bg-neutral-50 p-4">
            <Checkbox
              checked={useAllDomains}
              onChange={(event) => setUseAllDomains(event.target.checked)}
              disabled={mailbox.isLoading || updateName.isPending}
            />
            <span>
              <span className="block text-sm font-medium text-neutral-900">{t("aliases.useAll")}</span>
              <span className="mt-1 block text-sm text-neutral-500">
                {t("mailbox.useAllHint")}
              </span>
            </span>
          </label>
          {updateName.isError && (
            <p className="text-sm text-red-600">
              {updateName.error instanceof Error
                ? updateName.error.message
                : t("mailbox.updateFailed")}
            </p>
          )}
          {updateName.isSuccess && (
            <p className="text-sm text-green-700">{t("mailbox.saved")}</p>
          )}
          <Button
            onClick={() => updateName.mutate()}
            disabled={mailbox.isLoading || updateName.isPending}
          >
            <Save className="h-4 w-4" />
            {updateName.isPending ? t("common.saving") : t("settings.mailbox.saveChanges")}
          </Button>
        </CardContent>
      </Card>

      <Card className="rounded-3xl border-0 bg-white p-6">
        <CardHeader className="py-0">
          <CardTitle>{t("mailbox.aliases")}</CardTitle>
          <CardDescription>
            {t("mailbox.aliasesDescription")}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 pt-5">
          {aliases.isLoading && <Skeleton className="h-12 w-full rounded-2xl" />}
          {(aliases.data?.aliases ?? []).map((alias) => (
            <div
              key={alias.id}
              className="flex items-center justify-between gap-3 rounded-2xl bg-neutral-50 px-4 py-3"
            >
              <div className="flex min-w-0 items-center gap-2">
                <AtSign className="h-4 w-4 shrink-0 text-neutral-400" />
                <p className="truncate no-font-mono text-sm font-medium text-neutral-900">
                  {alias.localPart}@{alias.hostname}
                </p>
              </div>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                aria-label={t("mailbox.removeAddress", { address: `${alias.localPart}@${alias.hostname}` })}
                disabled={removeAlias.isPending}
                onClick={() => removeAlias.mutate(alias.id)}
              >
                <Trash2 className="h-4 w-4 text-red-600" />
              </Button>
            </div>
          ))}
          {aliases.data && aliases.data.aliases.length === 0 && (
            <p className="rounded-2xl bg-neutral-50 px-4 py-3 text-sm text-neutral-500">
              {t("mailbox.noAliases")}
            </p>
          )}
          {aliases.isError && (
            <p className="text-sm text-red-600">
              {aliases.error instanceof Error
                ? aliases.error.message
                : t("mailbox.aliasesLoadFailed")}
            </p>
          )}
          <div className="flex gap-2">
            <Input
              value={aliasLocalPart}
              onChange={(event) => setAliasLocalPart(event.target.value)}
              placeholder={t("mailbox.aliasPlaceholder")}
              className="min-w-0 flex-1"
              disabled={addAlias.isPending}
            />
            <Select
              value={aliasDomainId}
              onChange={(event) => setAliasDomainId(event.target.value)}
              className="h-10 min-w-0 flex-1 text-sm"
              disabled={addAlias.isPending}
            >
              {(aliases.data?.availableDomains ?? []).map((domain) => (
                <option key={domain.id} value={domain.id}>
                  @{domain.hostname}
                </option>
              ))}
            </Select>
            <Button
              type="button"
              disabled={!aliasLocalPart.trim() || !aliasDomainId || addAlias.isPending}
              onClick={() => addAlias.mutate()}
            >
              <AtSign className="h-4 w-4" />
              {addAlias.isPending ? t("account.mailboxes.adding") : t("mailbox.addAlias")}
            </Button>
          </div>
          {addAlias.isError && (
            <p className="text-sm text-red-600">
              {addAlias.error instanceof Error ? addAlias.error.message : t("mailbox.aliasAddFailed")}
            </p>
          )}
          {removeAlias.isError && (
            <p className="text-sm text-red-600">
              {removeAlias.error instanceof Error
                ? removeAlias.error.message
                : t("mailbox.aliasRemoveFailed")}
            </p>
          )}
        </CardContent>
      </Card>

      {mailbox.data?.canManageSharing && (
        <Card className="rounded-3xl border-0 bg-white p-6">
          <CardHeader className="py-0">
            <CardTitle>{t("mailbox.sharedAccess")}</CardTitle>
            <CardDescription>
              {t("mailbox.sharedAccessDescription")}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4 pt-5">
            {sharedAccess.isLoading && <Skeleton className="h-16 w-full rounded-2xl" />}
            {(sharedAccess.data?.members ?? []).map((member) => (
              <div
                key={member.userId}
                className="flex items-center justify-between gap-3 rounded-2xl bg-neutral-50 px-4 py-3"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-neutral-900">
                    {member.userName}
                  </p>
                  <p className="truncate text-xs text-neutral-500">{member.userEmail}</p>
                </div>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  aria-label={t("mailbox.removeAddress", { address: member.userName })}
                  disabled={removeMember.isPending}
                  onClick={() => removeMember.mutate(member.userId)}
                >
                  <Trash2 className="h-4 w-4 text-red-600" />
                </Button>
              </div>
            ))}
            {sharedAccess.data && sharedAccess.data.members.length === 0 && (
              <p className="rounded-2xl bg-neutral-50 px-4 py-3 text-sm text-neutral-500">
                {t("mailbox.noMembers")}
              </p>
            )}
            {sharedAccess.isError && (
              <p className="text-sm text-red-600">
                {sharedAccess.error instanceof Error
                  ? sharedAccess.error.message
                  : t("mailbox.sharedLoadFailed")}
              </p>
            )}
            <div className="flex gap-2">
              <Select
                value={selectedUserId}
                onChange={(event) => setSelectedUserId(event.target.value)}
                className="h-10 min-w-0 flex-1 text-sm"
              >
                <option value="">{t("mailbox.chooseAccount")}</option>
                {(sharedAccess.data?.availableUsers ?? [])
                  .filter(
                    (account) =>
                      !sharedAccess.data?.members.some((member) => member.userId === account.id),
                  )
                  .map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.name} ({account.email})
                    </option>
                  ))}
              </Select>
              <Button
                type="button"
                disabled={!selectedUserId || addMember.isPending}
                onClick={() => addMember.mutate()}
              >
                <UserPlus className="h-4 w-4" />
                {addMember.isPending ? t("account.mailboxes.adding") : t("mailbox.addUser")}
              </Button>
            </div>
            {addMember.isError && (
              <p className="text-sm text-red-600">
                {addMember.error instanceof Error ? addMember.error.message : t("mailbox.accountAddFailed")}
              </p>
            )}
          </CardContent>
        </Card>
      )}
      <Card className="rounded-3xl border-0 bg-white p-6">
        <CardHeader className="py-0">
          <CardTitle className="text-red-700">{t("mailbox.dangerZone")}</CardTitle>
          <CardDescription>
            {t("mailbox.dangerDescription", { address: address || t("mailbox.thisAddress") })}
          </CardDescription>
        </CardHeader>
        <CardContent className="pt-5">
          {removeMailbox.isError && (
            <p className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {removeMailbox.error instanceof Error
                ? removeMailbox.error.message
                : t("mailbox.deleteFailed")}
            </p>
          )}
          <Button
            type="button"
            variant="destructive"
            disabled={!mailbox.data || removeMailbox.isPending}
            onClick={() => {
              if (
                !window.confirm(
                  t("mailbox.deleteConfirm", { address }),
                )
              )
                return;
              removeMailbox.mutate();
            }}
          >
            <Trash2 className="h-4 w-4" />
            {removeMailbox.isPending ? t("mailbox.deleting") : t("mailbox.delete")}
          </Button>
        </CardContent>
      </Card>

{/* 
      <Card className="rounded-3xl border-0 bg-white p-6">
        <CardHeader className="py-0">
          <CardTitle>Address</CardTitle>
          <CardDescription>
            The email address, username, and domain are managed as routing
            resources.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 pt-5">
          <div className="space-y-1">
            <p className="text-xs font-medium uppercase tracking-wide text-neutral-500">
              Email
            </p>
            <p className="truncate no-font-mono text-sm text-neutral-900">
              {address || "-"}
            </p>
          </div>
          <div className="space-y-1">
            <p className="text-xs font-medium uppercase tracking-wide text-neutral-500">
              Username
            </p>
            <p className="truncate no-font-mono text-sm text-neutral-900">
              {mailbox.data?.localPart ?? "-"}
            </p>
          </div>
          <div className="space-y-1">
            <p className="text-xs font-medium uppercase tracking-wide text-neutral-500">
              Domain
            </p>
            <p className="truncate no-font-mono text-sm text-neutral-900">
              {mailbox.data?.hostname ?? "-"}
            </p>
          </div>
          <div className="space-y-1">
            <p className="text-xs font-medium uppercase tracking-wide text-neutral-500">
              Routing
            </p>
            <p className="flex items-center gap-2 text-sm text-neutral-900">
              <Mail className="h-4 w-4 text-neutral-400" />
              Cloudflare Email Routing
            </p>
          </div>
        </CardContent>
      </Card> */}
    </div>
  );
}
