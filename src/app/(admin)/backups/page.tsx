"use client";

import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  AlertTriangle,
  DatabaseBackup,
  Download,
  MoreVertical,
  Play,
  RefreshCw,
  Save,
  Settings,
  Trash2,
  Upload,
} from "@/components/icons";
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
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { SkeletonRows } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { BACKUP_TABLE_GROUPS } from "@/lib/backups/table-groups";
import type { TranslationKey } from "@/lib/i18n/types";
import type { BackupItem, BackupSettings } from "./types";
import {
  WEEKDAYS,
  downloadBackup,
  fetchBackups,
  formatBackupDate,
  formatBackupSize,
  getStatusClass,
  removeBackup,
  restoreBackup,
  saveBackupSettings,
  startBackup,
} from "./utils";

export default function BackupsPage() {
  const { t } = useLanguage();
  const queryClient = useQueryClient();
  const restoreInput = useRef<HTMLInputElement | null>(null);
  const savedSettings = useRef<BackupSettings | null>(null);
  const [settings, setSettings] = useState<BackupSettings | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const backups = useQuery({
    queryKey: ["backups"],
    queryFn: fetchBackups,
    refetchInterval: (query) =>
      query.state.data?.backups.some(
        (backup) => backup.status === "queued" || backup.status === "running",
      )
        ? 5000
        : false,
  });

  useEffect(() => {
    if (backups.data?.settings && !settings) {
      savedSettings.current = backups.data.settings;
      setSettings(backups.data.settings);
    }
  }, [backups.data?.settings, settings]);

  const saveSettings = useMutation({
    mutationFn: saveBackupSettings,
    onSuccess: (_data, nextSettings) => {
      savedSettings.current = nextSettings;
      setSettingsOpen(false);
      return queryClient.invalidateQueries({ queryKey: ["backups"] });
    },
  });

  const autoSaveSettings = useMutation({
    mutationFn: saveBackupSettings,
    onMutate: (nextSettings) => setSettings(nextSettings),
    onSuccess: (_data, nextSettings) => { savedSettings.current = nextSettings; },
    onError: () => { if (savedSettings.current) setSettings(savedSettings.current); },
  });

  const runBackup = useMutation({
    mutationFn: startBackup,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["backups"] }),
  });

  const deleteBackup = useMutation({
    mutationFn: removeBackup,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["backups"] }),
  });

  const download = useMutation({ mutationFn: downloadBackup });
  const restore = useMutation({
    mutationFn: restoreBackup,
    onSuccess: () => window.location.assign("/login"),
  });
  const error =
    backups.error ||
    saveSettings.error ||
    autoSaveSettings.error ||
    runBackup.error ||
    deleteBackup.error ||
    download.error ||
    restore.error;
  const configuration = backups.data?.configuration;
  const backupConfigured = configuration?.configured === true;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl md:text-3xl font-medium text-neutral-900">
            {t("backups.title")}
          </h1>
          <p className="mt-1 text-sm text-neutral-500">
            {t("backups.description")}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Input
            ref={restoreInput}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (!file || !window.confirm(t("backups.restoreConfirm"))) return;
              restore.mutate(file);
            }}
          />
          <Button onClick={() => runBackup.mutate()} disabled={runBackup.isPending || !backupConfigured}>
            <Play size={18} />
            {runBackup.isPending ? t("backups.starting") : t("backups.backUp")}
          </Button>
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <Button type="button" variant="outline" className="h-10 w-10 px-0" aria-label={t("backups.actions")}>
                <MoreVertical className="h-4 w-4" />
              </Button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content align="end" sideOffset={6} className="z-50 min-w-48 rounded-lg border border-neutral-200 bg-white p-1 text-sm shadow-lg">
                <DropdownMenu.Item disabled={restore.isPending} onSelect={() => restoreInput.current?.click()} className="flex cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-neutral-900 outline-none hover:bg-neutral-100 focus:bg-neutral-100 data-[disabled]:pointer-events-none data-[disabled]:opacity-50">
                  <Upload className="h-4 w-4" />
                  {restore.isPending ? t("backups.restoring") : t("backups.restore")}
                </DropdownMenu.Item>
                <DropdownMenu.Item disabled={!settings || autoSaveSettings.isPending} onSelect={() => setSettingsOpen(true)} className="flex cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-neutral-900 outline-none hover:bg-neutral-100 focus:bg-neutral-100 data-[disabled]:pointer-events-none data-[disabled]:opacity-50">
                  <Settings className="h-4 w-4" />
                  {t("backups.settings")}
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        </div>
      </div>

      <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
        <DialogContent className="max-h-[calc(100vh-4rem)] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t("backups.tablesTitle")}</DialogTitle>
            <DialogDescription>{t("backups.tablesDescription")}</DialogDescription>
          </DialogHeader>
          {settings && <div className="space-y-5">
            <div className="divide-y divide-neutral-100">
              {BACKUP_TABLE_GROUPS.map((group) => {
                const enabled = !settings.excludedTableGroups.includes(group.id);
                const lastEnabled = enabled && settings.excludedTableGroups.length === BACKUP_TABLE_GROUPS.length - 1;
                return <div key={group.id} className="flex items-start justify-between gap-4 py-4 first:pt-0 last:pb-0">
                  <div className="min-w-0"><p className="text-sm font-medium text-neutral-900">{group.label}</p><p className="mt-1 break-words text-xs text-neutral-500">{t("backups.tables", { list: group.tables.join(", ") })}</p></div>
                  <Switch checked={enabled} disabled={lastEnabled} onCheckedChange={(checked) => setSettings({ ...settings, excludedTableGroups: checked ? settings.excludedTableGroups.filter((id) => id !== group.id) : [...settings.excludedTableGroups, group.id] })} aria-label={t("backups.backUpGroup", { group: group.label })} />
                </div>;
              })}
            </div>
            {saveSettings.error && <p role="alert" className="text-sm text-red-700">{saveSettings.error instanceof Error ? saveSettings.error.message : t("backups.saveSettingsFailed")}</p>}
            <Button onClick={() => saveSettings.mutate(settings)} disabled={saveSettings.isPending}><Save className="h-4 w-4" />{saveSettings.isPending ? t("common.saving") : t("backups.saveSettings")}</Button>
          </div>}
        </DialogContent>
      </Dialog>

      {error && (
        <p className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error instanceof Error ? error.message : t("backups.operationFailed")}
        </p>
      )}

      {configuration && !configuration.configured && (
        <Card className="rounded-3xl border border-amber-200 bg-amber-50 p-6">
          <CardHeader className="py-0">
            <div className="flex items-start gap-3">
              <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-700" />
              <div>
                <CardTitle className="text-amber-950">
                  {t("backups.setupTitle")}
                </CardTitle>
                <CardDescription className="mt-1 text-amber-800">
                  {t("backups.setupDescription")}
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="pt-5">
            <div className="flex flex-wrap items-center gap-2">
              {configuration.missing.map((item) => (
                <Badge
                  key={item}
                  variant="outline"
                  className="border-amber-300 bg-white/70 text-amber-900"
                >
                  {item}
                </Badge>
              ))}
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="ml-auto border-amber-300 bg-white/70"
                disabled={backups.isFetching}
                onClick={() => void backups.refetch()}
              >
                <RefreshCw
                  className={`h-4 w-4 ${backups.isFetching ? "animate-spin" : ""}`}
                />
                {t("backups.checkAgain")}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <Card className="rounded-3xl border-0 bg-white p-6">
        <CardHeader className="py-0">
          <CardTitle>{t("backups.automatic")}</CardTitle>
          <CardDescription>
            {t("backups.scheduleNote")}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5 pt-5">
          {settings && (
            <>
              <div className="flex items-center justify-between gap-4 border-t border-neutral-100 pt-5">
                <Label htmlFor="automatic-backup-switch">{t("backups.enableAutomatic")}</Label>
                <Switch
                  id="automatic-backup-switch"
                  checked={settings.enabled}
                  disabled={autoSaveSettings.isPending}
                  onCheckedChange={(enabled) => autoSaveSettings.mutate({ ...settings, enabled })}
                />
              </div>
              {settings.enabled && (
                <>
                  <div className="grid gap-4">
                    <div className="flex items-center justify-between gap-4">
                      <Label htmlFor="schedule-type" className="flex-1">{t("backups.frequency")}</Label>
                      <Select
                        id="schedule-type"
                        value={settings.scheduleType}
                        containerClassName="w-1/2 max-w-52 shrink-0 text-sm"
                        disabled={autoSaveSettings.isPending}
                        onChange={(event) => {
                          const scheduleType = event.target
                            .value as BackupSettings["scheduleType"];
                          autoSaveSettings.mutate({
                            ...settings,
                            scheduleType,
                            scheduleValue:
                              scheduleType === "weekly"
                                ? 1
                                : scheduleType === "monthly"
                                  ? 1
                                  : null,
                          });
                        }}
                        className="px-3 py-2"
                      >
                        <option value="daily">{t("backups.daily")}</option>
                        <option value="weekly">{t("backups.weekly")}</option>
                        <option value="monthly">{t("backups.monthly")}</option>
                      </Select>
                    </div>

                    {settings.scheduleType === "weekly" && (
                      <div className="flex items-center justify-between gap-4">
                        <Label htmlFor="weekday">{t("backups.dayOfWeek")}</Label>
                        <Select
                          id="weekday"
                          value={settings.scheduleValue ?? 1}
                          containerClassName="w-1/2 max-w-52 shrink-0"
                          disabled={autoSaveSettings.isPending}
                          onChange={(event) =>
                            autoSaveSettings.mutate({
                              ...settings,
                              scheduleValue: Number(event.target.value),
                            })
                          }
                          
                        className="px-3 py-2 text-sm"
                        >
                          {WEEKDAYS.map((day) => (
                            <option key={day.value} value={day.value}>
                              {t(day.labelKey)}
                            </option>
                          ))}
                        </Select>
                      </div>
                    )}

                    {settings.scheduleType === "monthly" && (
                      <div className="flex items-center justify-between gap-4">
                        <Label htmlFor="month-day">{t("backups.dayOfMonth")}</Label>
                        <Input
                          id="month-day"
                          className="w-1/2 max-w-52 shrink-0"
                          type="number"
                          min={1}
                          max={28}
                          value={settings.scheduleValue ?? 1}
                          disabled={autoSaveSettings.isPending}
                          onChange={(event) =>
                            setSettings({
                              ...settings,
                              scheduleValue: Number(event.target.value),
                            })
                          }
                          onBlur={(event) => {
                            if (event.currentTarget.checkValidity()) autoSaveSettings.mutate(settings);
                            else setSettings({ ...settings, scheduleValue: savedSettings.current?.scheduleValue ?? 1 });
                          }}
                        />
                      </div>
                    )}
                  </div>

                  <div className="grid gap-4 border-t border-neutral-100 pt-5">
                    <div className="flex items-center justify-between gap-4">
                      <Label htmlFor="retention-switch">{t("backups.deleteOld")}</Label>
                      <Switch
                        id="retention-switch"
                        checked={settings.retentionEnabled}
                        disabled={autoSaveSettings.isPending}
                        onCheckedChange={(retentionEnabled) =>
                          autoSaveSettings.mutate({
                            ...settings,
                            retentionEnabled,
                          })
                        }
                      />
                    </div>

                    <div className="flex items-center justify-between gap-4">
                      <Label htmlFor="retention-days">
                        {t("backups.deleteOlderThan")}
                      </Label>
                      <div className="flex w-1/2 max-w-52 shrink-0 items-center gap-2 relative">
                        <Input
                          id="retention-days"
                          className="min-w-0"
                          type="number"
                          min={1}
                          max={3650}
                          value={settings.retentionDays}
                          disabled={!settings.retentionEnabled || autoSaveSettings.isPending}
                          onChange={(event) =>
                            setSettings({
                              ...settings,
                              retentionDays: Number(event.target.value),
                            })
                          }
                          onBlur={(event) => {
                            if (event.currentTarget.checkValidity()) autoSaveSettings.mutate(settings);
                            else setSettings({ ...settings, retentionDays: savedSettings.current?.retentionDays ?? 30 });
                          }}
                        />
                        <span className="text-sm text-neutral-500 absolute z-10 right-6">{t("backups.days")}</span>
                      </div>
                    </div>
                  </div>
                </>
              )}
            </>
          )}
        </CardContent>
      </Card>

      <section className="overflow-hidden rounded-3xl bg-white">
        <div className="flex items-center gap-3 border-b border-neutral-100 px-4 py-4">
          <DatabaseBackup className="h-5 w-5 text-neutral-500" />
          <h2 className="font-semibold text-neutral-900">{t("backups.history")}</h2>
        </div>
        <div className="grid grid-cols-[1fr_110px_110px_170px_120px] gap-4 border-b border-neutral-100 bg-neutral-50 px-4 py-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">
          <span>{t("backups.col.file")}</span>
          <span>{t("backups.col.status")}</span>
          <span>{t("backups.col.size")}</span>
          <span>{t("backups.col.created")}</span>
          <span>{t("backups.col.actions")}</span>
        </div>
        {backups.isLoading && <SkeletonRows count={5} />}
        {!backups.isLoading && (backups.data?.backups ?? []).length === 0 && (
          <p className="px-4 py-6 text-sm text-neutral-500">{t("backups.none")}</p>
        )}
        {(backups.data?.backups ?? []).map((backup: BackupItem) => (
          <div
            key={backup.id}
            className="grid grid-cols-[1fr_110px_110px_170px_120px] items-center gap-4 border-b border-neutral-100 px-4 py-3 last:border-b-0"
          >
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-neutral-900">
                {backup.filename ?? backup.id}
              </p>
              <p className="truncate text-xs text-neutral-500">
                {backup.trigger === "manual" ? t("backups.manual") : t("backups.scheduled")}
                {backup.error ? `: ${backup.error}` : ""}
              </p>
            </div>
            <Badge variant="outline" className={getStatusClass(backup.status)}>
              {t(`backups.status.${backup.status}` as TranslationKey)}
            </Badge>
            <span className="text-sm text-neutral-600">
              {formatBackupSize(backup.size)}
            </span>
            <span className="text-sm text-neutral-600">
              {formatBackupDate(backup.createdAt)}
            </span>
            <div className="flex gap-1">
              <Button
                size="sm"
                variant="ghost"
                title={t("backups.download")}
                disabled={backup.status !== "completed" || download.isPending}
                onClick={() => download.mutate(backup)}
              >
                <Download className="h-4 w-4" />
              </Button>
              <Button
                size="sm"
                variant="ghost"
                title={t("backups.delete")}
                disabled={
                  deleteBackup.isPending ||
                  backup.status === "queued" ||
                  backup.status === "running"
                }
                onClick={() => deleteBackup.mutate(backup.id)}
              >
                <Trash2 className="h-4 w-4 text-red-600" />
              </Button>
            </div>
          </div>
        ))}
      </section>
    </div>
  );
}
