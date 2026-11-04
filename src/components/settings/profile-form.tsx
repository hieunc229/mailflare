"use client";

import { useEffect, useState } from "react";
import { useLanguage } from "@/components/language-provider";
import { useSelectedMailbox } from "@/components/mailbox-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authFetch } from "@/lib/auth/client";
import { dispatchProfileNameChanged } from "@/lib/profile/name-client";
import { InboxSwitcher } from "./inbox-switcher";
import { ProfileAvatarForm } from "./profile-avatar-form";
import type { ProfileFormProps, ProfileFormResponse } from "./types";
import { getMailboxAddress, updateCurrentMailboxName } from "./utils";

export function ProfileForm({
  accountName,
  initialResetEmail,
}: ProfileFormProps) {
  const { t } = useLanguage();
  const { selectedMailbox, setSelectedMailbox, isLoading } = useSelectedMailbox();
  const [name, setName] = useState("");
  const [savedName, setSavedName] = useState("");
  const [resetEmail, setResetEmail] = useState(initialResetEmail);
  const [savedResetEmail, setSavedResetEmail] = useState(initialResetEmail);
  const [profileStatus, setProfileStatus] = useState<string | null>(null);
  const [recoveryStatus, setRecoveryStatus] = useState<string | null>(null);
  const [savingProfile, setSavingProfile] = useState(false);
  const [savingRecovery, setSavingRecovery] = useState(false);

  useEffect(() => {
    const nextName = selectedMailbox?.displayName ?? "";
    setName(nextName);
    setSavedName(nextName);
    setProfileStatus(null);
  }, [selectedMailbox?.id, selectedMailbox?.displayName]);

  // Name and avatar belong to the selected inbox. Only the primary inbox is the
  // account itself, so the recovery email applies to it alone.
  const isPrimary = !!selectedMailbox?.isPrimary && selectedMailbox.type === "personal";

  async function saveProfile(nextName: string, nextResetEmail: string) {
    try {
      const res = await authFetch("/api/settings/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: nextName, resetEmail: nextResetEmail }),
      });
      const data = (await res.json()) as ProfileFormResponse;

      if (!res.ok) {
        throw new Error(
          typeof data.error === "string"
            ? data.error
            : t("settings.profile.updateFailed"),
        );
      }

      const nextSavedResetEmail = data.user?.resetEmail ?? "";
      setResetEmail(nextSavedResetEmail);
      setSavedResetEmail(nextSavedResetEmail);
    } catch (error) {
      throw error instanceof Error
        ? error
        : new Error(t("settings.profile.updateFailed"));
    }
  }

  async function onProfileSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSavingProfile(true);
    setProfileStatus(null);
    try {
      if (!selectedMailbox) return;
      const updated = await updateCurrentMailboxName(selectedMailbox.id, name);
      setSelectedMailbox({ ...selectedMailbox, ...updated });
      setName(updated.displayName ?? "");
      setSavedName(updated.displayName ?? "");
      // The primary inbox is the account, so its name is the profile name.
      if (isPrimary) dispatchProfileNameChanged(updated.displayName ?? "");
      setProfileStatus(t("common.saved"));
    } catch (error) {
      setProfileStatus(
        error instanceof Error ? error.message : t("settings.profile.updateFailed"),
      );
    } finally {
      setSavingProfile(false);
    }
  }

  async function onRecoverySubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSavingRecovery(true);
    setRecoveryStatus(null);
    try {
      await saveProfile(accountName, resetEmail);
      setRecoveryStatus(t("common.saved"));
    } catch (error) {
      setRecoveryStatus(
        error instanceof Error
          ? error.message
          : t("settings.profile.recoveryFailed"),
      );
    } finally {
      setSavingRecovery(false);
    }
  }

  if (isLoading) {
    return <p className="rounded-t-3xl rounded-b-lg bg-white p-6 text-sm text-neutral-500">{t("settings.signature.loadingInbox")}</p>;
  }
  if (!selectedMailbox) {
    return <p className="rounded-t-3xl rounded-b-lg bg-white p-6 text-sm text-neutral-500">{t("settings.signature.selectInbox")}</p>;
  }

  const address = getMailboxAddress(selectedMailbox);
  const canManage = selectedMailbox.permission === "full_access";

  return (
    <>
      <form
        onSubmit={onProfileSubmit}
        className="space-y-6 rounded-b-lg rounded-t-3xl bg-white p-6"
      >
        <InboxSwitcher />
        <div className="flex items-center gap-4">
          <ProfileAvatarForm
            mailboxId={selectedMailbox.id}
            initialHasAvatar={!!selectedMailbox.hasAvatar}
            name={savedName || selectedMailbox.localPart}
            colorSeed={address}
          />
          <div>
            <p className="text-sm font-medium text-neutral-900">
              {t("settings.profile.pictureTitle")}
            </p>
            <p className="mt-1 text-sm text-neutral-500">
              {t("settings.profile.pictureDescription")}
            </p>
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="name">{t("common.name")}</Label>
          <Input
            id="name"
            autoComplete="name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={selectedMailbox.localPart}
            required={isPrimary}
            disabled={!canManage || savingProfile}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="accountEmail">{t("settings.profile.currentEmail")}</Label>
          <Input
            id="accountEmail"
            autoComplete="email"
            value={address}
            type="email"
            readOnly
            aria-readonly="true"
            className="bg-neutral-50"
          />
        </div>

        <div className="flex items-center gap-3">
          <Button
            type="submit"
            disabled={!canManage || savingProfile || name.trim() === savedName}
          >
            {savingProfile ? t("common.saving") : t("settings.profile.save")}
          </Button>
          {profileStatus && (
            <p className="text-sm text-neutral-500">{profileStatus}</p>
          )}
        </div>
      </form>

      {isPrimary && <form
        onSubmit={onRecoverySubmit}
        className="space-y-4 rounded-lg bg-white p-6"
      >
        <div>
          <h3 className="text-lg font-semibold text-neutral-900">
            {t("settings.profile.recoveryTitle")}
          </h3>
          <p className="mt-1 text-sm text-neutral-500">
            {t("settings.profile.recoveryDescription")}
          </p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="resetEmail">{t("settings.profile.emailAddress")}</Label>
          <Input
            id="resetEmail"
            autoComplete="email"
            value={resetEmail}
            onChange={(event) => setResetEmail(event.target.value)}
            type="email"
            placeholder="recovery@example.com"
          />
        </div>
        <div className="flex items-center gap-3">
          <Button
            type="submit"
            disabled={savingRecovery || resetEmail.trim() === savedResetEmail}
          >
            {savingRecovery ? t("common.saving") : t("settings.profile.saveRecovery")}
          </Button>
          {recoveryStatus && (
            <p className="text-sm text-neutral-500">{recoveryStatus}</p>
          )}
        </div>
      </form>}
    </>
  );
}
