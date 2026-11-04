"use client";

import type { FormEvent } from "react";
import { useMemo, useState } from "react";
import { Folder, Server, Upload } from "@/components/icons";
import { useLanguage } from "@/components/language-provider";
import type { TranslationKey } from "@/lib/i18n/types";
import { useSelectedMailbox } from "@/components/mailbox-provider";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { ImportJobs } from "@/components/settings/import-jobs";
import { importMessageFiles } from "@/components/settings/import-messages-utils";
import { TakeoutImport } from "@/components/settings/takeout-import";
import type {
  ImapFormState,
  ImportSourceItem,
  ImportSourceSection,
  ImportTab,
  ImportProgress,
} from "./types";
import {
  ensureImportDestination,
  fetchImapFolders,
  filterCustomImapFolders,
  getFileImportSource,
  getFolderImportSource,
  getSelectedImportSources,
  importSourceOptions,
  resolveImapSourceFolder,
  startImapImport,
} from "./utils";

const initialImapForm: ImapFormState = {
  host: "",
  port: "993",
  secure: true,
  username: "",
  password: "",
  folder: "INBOX",
  limit: "100",
  importAll: true,
};

const defaultSections = importSourceOptions.map((option) => option.value);

const SECTION_LABEL_KEYS: Record<ImportSourceSection, TranslationKey> = {
  inbox: "navigation.inbox",
  sent: "navigation.sent",
  drafts: "navigation.drafts",
  archived: "navigation.archived",
  spam: "navigation.spam",
  trash: "navigation.trash",
  others: "importPage.others",
};

export default function SettingsImportPage() {
  const { t } = useLanguage();
  // System sections are translated; folders discovered on the source keep their own names.
  const sourceLabel = (source: ImportSourceItem) => source.sourceSection ? t(SECTION_LABEL_KEYS[source.sourceSection]) : source.label;
  const { selectedMailbox } = useSelectedMailbox();
  const [activeTab, setActiveTab] = useState<ImportTab>("file");
  const [selectedSections, setSelectedSections] =
    useState<ImportSourceSection[]>(defaultSections);
  const [sourceDropdownOpen, setSourceDropdownOpen] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [fileStarted, setFileStarted] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [fileProgress, setFileProgress] = useState<ImportProgress | null>(null);
  const [imapForm, setImapForm] = useState<ImapFormState>(initialImapForm);
  const [imapStarted, setImapStarted] = useState(false);
  const [jobsRefresh, setJobsRefresh] = useState(0);
  const [imapError, setImapError] = useState<string | null>(null);
  const [imapLoading, setImapLoading] = useState(false);
  const [imapProgress, setImapProgress] = useState<ImportProgress | null>(null);
  const selectedSources = useMemo(
    () => getSelectedImportSources(selectedSections),
    [selectedSections],
  );
  const fileImportSource = getFileImportSource(selectedSources);
  const sourceSummary =
    selectedSources.length > 0
      ? selectedSources.map(sourceLabel).join(", ")
      : t("importPage.selectSections");

  function toggleSection(section: ImportSourceSection, checked: boolean) {
    setSelectedSections((current) => {
      if (checked)
        return current.includes(section) ? current : [...current, section];
      return current.filter((item) => item !== section);
    });
  }

  async function getDestination(source: ImportSourceItem): Promise<string> {
    if (!selectedMailbox?.id) throw new Error(t("importPage.selectMailboxFirst"));
    return ensureImportDestination(selectedMailbox.id, source);
  }

  async function onFileSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedMailbox?.id || selectedSources.length === 0) return;

    setFileLoading(true);
    setFileError(null);
    setFileStarted(false);
    setFileProgress({ completed: 0, total: 100, label: t("importPage.preparing") });
    try {
      const destination = await getDestination(fileImportSource);
      await importMessageFiles(
        selectedMailbox.id,
        files,
        destination,
        (percentage) =>
          setFileProgress({
            completed: percentage,
            total: 100,
            label: t("importPage.uploading"),
          }),
      );
      setFileStarted(true);
      setJobsRefresh((count) => count + 1);
    } catch (error) {
      setFileError(
        error instanceof Error ? error.message : t("importPage.fileFailed"),
      );
    } finally {
      setFileLoading(false);
      setFileProgress(null);
    }
  }

  async function onImapSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedMailbox?.id || selectedSources.length === 0) return;
    setImapLoading(true);
    setImapError(null);
    setImapStarted(false);
    setImapProgress({
      completed: 0,
      total: 1,
      label: t("importPage.discovering"),
    });
    try {
      const discoveredFolders = await fetchImapFolders(imapForm);
      const expandedSources: ImportSourceItem[] = [];
      for (const source of selectedSources) {
        if (source.id === "system:others") {
          expandedSources.push(
            ...filterCustomImapFolders(discoveredFolders, selectedSources).map(
              getFolderImportSource,
            ),
          );
        } else {
          expandedSources.push(source);
        }
      }

      const sources: { folder: string; destination: string }[] = [];
      for (const source of expandedSources) {
        sources.push({
          folder: resolveImapSourceFolder(source, discoveredFolders),
          destination: await getDestination(source),
        });
      }
      await startImapImport(selectedMailbox.id, imapForm, sources);
      setImapStarted(true);
      setJobsRefresh((count) => count + 1);
      setImapForm((current) => ({ ...current, password: "" }));
    } catch (error) {
      setImapError(
        error instanceof Error ? error.message : t("importPage.imapFailed"),
      );
    } finally {
      setImapLoading(false);
      setImapProgress(null);
    }
  }

  return (
    <div className="space-y-6">
      <h1 className="sr-only">{t("settings.nav.import")}</h1>
      {/* <div>
        <h1 className="text-2xl md:text-3xl font-medium text-neutral-900">Import</h1>
        <p className="mt-1 text-sm text-neutral-500">
          Move mail from selected source sections into the matching sections of
          the current mailbox.
        </p>
      </div> */}

      <ImportJobs refreshKey={jobsRefresh} />

      <section className="space-y-4">
        <div>
          <h2 className="text-xl font-semibold text-neutral-900">
            {t("importPage.title")}
          </h2>
          <p className="mt-1 text-sm text-neutral-500">
            {t("importPage.description")}
          </p>
        </div>
        <div className="space-y-1 overflow-hidden rounded-3xl">
          <CardContent className="space-y-6 rounded-b-lg rounded-t-3xl bg-white p-6">
            <div className="flex flex-col gap-2">
              <Label htmlFor="import-source">{t("importPage.source")}</Label>
              <Select
                id="import-source"
                value={activeTab}
                onChange={(event) =>
                  setActiveTab(event.target.value as ImportTab)
                }
                className="text-sm w-full py-2"
                // className="h-10 w-full rounded-md border border-neutral-200 bg-white px-3 text-sm text-neutral-900 shadow-sm shadow-neutral-200/50 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
              >
                <option value="file">{t("importPage.backupFile")}</option>
                <option value="imap">{t("importPage.imap")}</option>
                <option value="takeout">{t("importPage.takeout")}</option>
              </Select>
            </div>
            {activeTab === "takeout" ? (
              <TakeoutImport />
            ) : (
            <>
            <div className="space-y-2">
              <Label>{t("importPage.chooseSections")}</Label>

              <div className="relative">
                <button
                  type="button"
                  onClick={() => setSourceDropdownOpen((open) => !open)}
                  className="flex w-full items-center justify-between rounded-md border border-neutral-200 bg-white px-3 py-2 text-left text-sm shadow-sm shadow-neutral-200/50"
                >
                  <label className="flex-1">{t("importPage.selected")}</label>
                  <span className="truncate">{sourceSummary}</span>
                  <span className="text-neutral-500 px-2">▾</span>
                </button>
                {sourceDropdownOpen && (
                  <div className="absolute z-20 mt-2 w-full rounded-xl border border-neutral-200 bg-white p-2 shadow-lg">
                    {importSourceOptions.map((option) => (
                      <label
                        key={option.value}
                        className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-neutral-700 hover:bg-neutral-50"
                      >
                        <Checkbox
                          checked={selectedSections.includes(option.value)}
                          onChange={(event) =>
                            toggleSection(option.value, event.target.checked)
                          }
                        />
                        {t(SECTION_LABEL_KEYS[option.value])}
                      </label>
                    ))}
                  </div>
                )}
              </div>
              {/* <p className="text-xs leading-5 text-neutral-500">
            Select Folders to import every source IMAP folder into matching
            Mailflare folders.
          </p> */}
            </div>

            {activeTab === "file" ? (
              <>
                <form onSubmit={onFileSubmit} className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="import-files">{t("importPage.selectFile")}</Label>
                    <Input
                      id="import-files"
                      type="file"
                      accept=".eml,.mbox,.mbx,message/rfc822,application/mbox"
                      multiple
                      onChange={(event) =>
                        setFiles(Array.from(event.target.files ?? []))
                      }
                      className="block w-full rounded-md border border-neutral-200 bg-white px-3 py-1 text-sm shadow-sm shadow-neutral-200/50 file:mr-3 file:rounded-md file:border-0 file:bg-neutral-100 file:px-3 file:py-1.5 file:text-sm file:font-medium"
                    />
                    <p className="text-xs leading-5 text-neutral-500">
                      {t("importPage.fileHint", { section: sourceLabel(fileImportSource) })}
                    </p>
                  </div>
                  {selectedSections.includes("others") && (
                    <p className="rounded-lg border border-amber-100 bg-amber-50 px-4 py-3 text-sm text-amber-700">
                      {t("importPage.othersNote")}
                    </p>
                  )}
                  <Button
                    type="submit"
                    disabled={
                      !selectedMailbox ||
                      selectedSources.length === 0 ||
                      files.length === 0 ||
                      fileLoading
                    }
                  >
                    {fileLoading ? t("import.importing") : t("importPage.importFiles")}
                  </Button>
                  {fileProgress && (
                    <div
                      className="space-y-1 text-xs text-neutral-500"
                      aria-live="polite"
                    >
                      <div className="flex justify-between">
                        <span>{fileProgress.label}</span>
                        <span>{fileProgress.completed}%</span>
                      </div>
                      <div className="h-1.5 overflow-hidden rounded-full bg-neutral-100">
                        <div
                          className="h-full bg-blue-600 transition-[width]"
                          style={{ width: `${fileProgress.completed}%` }}
                        />
                      </div>
                    </div>
                  )}
                  {fileStarted && (
                    <p className="rounded-lg border border-green-100 bg-green-50 px-4 py-3 text-sm text-green-700">
                      {t("importJobs.started")}
                    </p>
                  )}
                  {fileError && (
                    <p className="rounded-lg border border-red-100 bg-red-50 px-4 py-3 text-sm text-red-700">
                      {fileError}
                    </p>
                  )}
                </form>
              </>
            ) : (
              <>
                <form onSubmit={onImapSubmit} className="space-y-4">
                  <div className="grid gap-3 md:grid-cols-[1fr_110px]">
                    <div className="space-y-2">
                      <Label htmlFor="imap-host">{t("importPage.host")}</Label>
                      <Input
                        id="imap-host"
                        value={imapForm.host}
                        onChange={(event) =>
                          setImapForm({ ...imapForm, host: event.target.value })
                        }
                        placeholder="imap.gmail.com"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="imap-port">{t("importPage.port")}</Label>
                      <Input
                        id="imap-port"
                        type="number"
                        value={imapForm.port}
                        onChange={(event) =>
                          setImapForm({ ...imapForm, port: event.target.value })
                        }
                      />
                    </div>
                  </div>
                  <div className="grid gap-3 md:grid-cols-2">
                    <div className="space-y-2">
                      <Label htmlFor="imap-username">{t("importPage.username")}</Label>
                      <Input
                        id="imap-username"
                        value={imapForm.username}
                        onChange={(event) =>
                          setImapForm({
                            ...imapForm,
                            username: event.target.value,
                          })
                        }
                        placeholder="you@example.com"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="imap-password">
                        {t("importPage.passwordOrApp")}
                      </Label>
                      <Input
                        id="imap-password"
                        type="password"
                        value={imapForm.password}
                        onChange={(event) =>
                          setImapForm({
                            ...imapForm,
                            password: event.target.value,
                          })
                        }
                        autoComplete="off"
                      />
                    </div>
                  </div>
                  <div className="grid gap-3 md:grid-cols-2">
                    <div className="space-y-2">
                      <Label htmlFor="imap-limit">
                        {imapForm.importAll
                          ? t("importPage.perBatch")
                          : t("importPage.perSource")}
                      </Label>
                      <Input
                        id="imap-limit"
                        type="number"
                        min={1}
                        max={100}
                        value={imapForm.limit}
                        onChange={(event) =>
                          setImapForm({
                            ...imapForm,
                            limit: event.target.value,
                          })
                        }
                      />
                    </div>
                    <label className="flex items-end gap-2 pb-2 text-sm text-neutral-700">
                      <Checkbox
                        checked={imapForm.importAll}
                        onChange={(event) =>
                          setImapForm({
                            ...imapForm,
                            importAll: event.target.checked,
                          })
                        }
                      />
                      {t("importPage.importAll")}
                    </label>
                    <label className="flex items-end gap-2 pb-2 text-sm text-neutral-700">
                      <Checkbox
                        checked={imapForm.secure}
                        onChange={(event) =>
                          setImapForm({
                            ...imapForm,
                            secure: event.target.checked,
                          })
                        }
                      />
                      {t("importPage.useTls")}
                    </label>
                  </div>
                  <p className="rounded-lg border border-neutral-200 bg-neutral-50 px-4 py-3 text-xs leading-5 text-neutral-500">
                    {t("importPage.imapNote")}
                  </p>
                  <Button
                    type="submit"
                    disabled={
                      !selectedMailbox ||
                      selectedSources.length === 0 ||
                      !imapForm.host ||
                      !imapForm.username ||
                      !imapForm.password ||
                      imapLoading
                    }
                  >
                    <Upload className="h-4 w-4" />
                    {imapLoading ? t("import.importing") : t("importPage.importSources")}
                  </Button>
                  {imapProgress && (
                    <div
                      className="space-y-1 text-xs text-neutral-500"
                      aria-live="polite"
                    >
                      <div className="flex justify-between">
                        <span>{imapProgress.label}</span>
                        <span>
                          {imapProgress.completed}/{imapProgress.total}
                        </span>
                      </div>
                      <div className="h-1.5 overflow-hidden rounded-full bg-neutral-100">
                        <div
                          className="h-full bg-blue-600 transition-[width]"
                          style={{
                            width: `${Math.round((imapProgress.completed / imapProgress.total) * 100)}%`,
                          }}
                        />
                      </div>
                    </div>
                  )}
                  {imapStarted && (
                    <p className="rounded-lg border border-green-100 bg-green-50 px-4 py-3 text-sm text-green-700">
                      {t("importJobs.started")}
                    </p>
                  )}
                  {imapError && (
                    <p className="rounded-lg border border-red-100 bg-red-50 px-4 py-3 text-sm text-red-700">
                      {imapError}
                    </p>
                  )}
                </form>
              </>
            )}
            </>
            )}
          </CardContent>
        </div>
      </section>
    </div>
  );
}
