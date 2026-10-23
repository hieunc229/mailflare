"use client";

import { mobilePrimaryActionClass } from "@/components/page-header-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { useLanguage } from "@/components/language-provider";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { List } from "@/components/ui/list";
import { CheckCircle2, LoaderCircle, Plus } from "lucide-react";
import { authFetch } from "@/lib/auth/client";
import type { DnsAuthRecord, DnsStatusSummary, Domain, DomainDnsCache, DomainDnsView, DomainPreflight, ReceivingProvider, SendingProvider } from "./types";
import DomainItemCard from "./DomainItemCard";
import { SectionRowSkeleton } from "@/components/page-skeletons";
import { checkDomain } from "./utils";
import { confirmMxReplacement, createDomain, isMxConflictError } from "./api";

export default function DomainsPage() {
  const { t } = useLanguage();
  const qc = useQueryClient();
  const [hostname, setHostname] = useState("");
  // Self-hosted installs without Cloudflare credentials manage DNS by hand.
  const { data: me } = useQuery({
    queryKey: ["me"],
    queryFn: async () => (await (await authFetch("/api/auth/me")).json()) as { managesDns?: boolean },
  });
  const managesDns = me?.managesDns ?? true;
  const [domainCheck, setDomainCheck] = useState<DomainPreflight | null>(null);
  const [domainChecking, setDomainChecking] = useState(false);
  const [skipDns, setSkipDns] = useState(false);
  const [sendingProvider, setSendingProvider] = useState<SendingProvider>("cloudflare");
  const [receivingProvider, setReceivingProvider] = useState<ReceivingProvider>("cloudflare");
  const [domainCheckError, setDomainCheckError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [setupRecord, setSetupRecord] = useState<DnsAuthRecord | null>(null);
  const [setupMessage, setSetupMessage] = useState<string | null>(null);
  const [expandedDomainId, setExpandedDomainId] = useState<string | null>(null);
  const expandedIdRef = useRef<string | null>(null);
  const [dnsLoading, setDnsLoading] = useState(false);
  const [dnsError, setDnsError] = useState<string | null>(null);
  const [dnsViews, setDnsViews] = useState<DomainDnsCache>({});

  const { data, isLoading } = useQuery({
    queryKey: ["domains"],
    queryFn: async () => {
      const res = await authFetch("/api/domains?includeDns=true");
      return (await res.json()) as {
        domains: Domain[];
        dns: Record<string, DnsStatusSummary>;
      };
    },
  });

  const create = useMutation({
    mutationFn: async () => {
      const normalized = hostname.toLowerCase().trim();
      let checkedDomain = domainCheck;
      if (skipDns) {
        checkedDomain = { hostname: normalized, zone: { id: "manual", name: normalized } };
      } else if (checkedDomain?.hostname !== normalized) {
        const result = await checkDomain(normalized);
        if (!result.ok || !result.domain) {
          throw new Error(result.error ?? t("onboarding.domainCheckFailed"));
        }
        checkedDomain = result.domain;
        setDomainCheck(result.domain);
      }
      if (!checkedDomain) throw new Error(t("onboarding.domainCheckFailed"));

      return createDomain({
        hostname: checkedDomain.hostname,
        enableRouting: true,
        skipDns,
        sendingProvider,
        receivingProvider,
      });
    },
    onSuccess: () => {
      setHostname("");
      setDomainCheck(null);
      setSkipDns(false);
      setSendingProvider("cloudflare");
      setReceivingProvider("cloudflare");
      setDomainCheckError(null);
      setCreateOpen(false);
      qc.invalidateQueries({ queryKey: ["domains"] });
    },
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      const res = await authFetch(`/api/domains/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(t("domains.removeFailed"));
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["domains"] }),
  });

  const loadDns = async (id: string) => {
    const res = await authFetch(`/api/domains/${id}/dns`);
    const json = (await res.json()) as {
      domain?: Domain;
      dns?: DomainDnsView;
      error?: string;
    };
    if (!res.ok || !json.domain || !json.dns) {
      throw new Error(json.error ?? t("domains.dnsLoadFailed"));
    }
    const loadedView = { domain: json.domain, dns: json.dns };
    setDnsViews((current) => ({ ...current, [id]: loadedView }));
    if (expandedIdRef.current === id) setSetupMessage(null);
  };

  const toggleDns = async (id: string) => {
    if (expandedDomainId === id) {
      expandedIdRef.current = null;
      setExpandedDomainId(null);
      setSetupMessage(null);
      setDnsLoading(false);
      setDnsError(null);
      return;
    }
    // Expand immediately and show a skeleton while the audit is fetched, rather
    // than leaving the card unchanged until the request resolves.
    expandedIdRef.current = id;
    setExpandedDomainId(id);
    setSetupMessage(null);
    setDnsError(null);
    if (dnsViews[id]) {
      setDnsLoading(false);
      return;
    }
    setDnsLoading(true);
    try {
      await loadDns(id);
    } catch (error) {
      if (expandedIdRef.current === id) {
        setDnsError(error instanceof Error ? error.message : t("domains.dnsLoadFailed"));
      }
    } finally {
      if (expandedIdRef.current === id) setDnsLoading(false);
    }
  };

  const [sendingBusy, setSendingBusy] = useState(false);
  const [sendingMessage, setSendingMessage] = useState<string | null>(null);

  const changeSendingProvider = async (provider: SendingProvider) => {
    if (!expandedDomainId) return;
    const id = expandedDomainId;
    setSendingBusy(true);
    setSendingMessage(null);
    try {
      const put = async (replaceMx: boolean) => {
        const res = await authFetch(`/api/domains/${id}/sending`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ provider, replaceMx }),
        });
        return { res, json: (await res.json()) as { warning?: string; error?: string; code?: string; records?: { content: string; priority: number }[] } };
      };
      let { res, json } = await put(false);
      // Cloudflare sending refuses while another service's MX records exist.
      if (confirmMxReplacement(res, json)) ({ res, json } = await put(true));
      if (!res.ok) throw new Error(json.error ?? t("domains.sendingChangeFailed"));
      if (json.warning) setSendingMessage(json.warning);
      await loadDns(id);
      qc.invalidateQueries({ queryKey: ["domains"] });
    } catch (error) {
      setSendingMessage(error instanceof Error ? error.message : t("domains.sendingChangeFailed"));
    } finally {
      setSendingBusy(false);
    }
  };

  const [receivingBusy, setReceivingBusy] = useState(false);
  const [receivingMessage, setReceivingMessage] = useState<string | null>(null);

  const changeReceivingProvider = async (provider: ReceivingProvider) => {
    if (!expandedDomainId) return;
    const id = expandedDomainId;
    setReceivingBusy(true);
    setReceivingMessage(null);
    try {
      const res = await authFetch(`/api/domains/${id}/receiving`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider }),
      });
      const json = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(json.error ?? t("domains.receivingChangeFailed"));
      await loadDns(id);
      qc.invalidateQueries({ queryKey: ["domains"] });
    } catch (error) {
      setReceivingMessage(error instanceof Error ? error.message : t("domains.receivingChangeFailed"));
    } finally {
      setReceivingBusy(false);
    }
  };

  const refreshExpandedDns = () => {
    if (!expandedDomainId) return;
    void loadDns(expandedDomainId).catch(() => undefined);
    qc.invalidateQueries({ queryKey: ["domains"] });
  };

  const setupDns = async (record: DnsAuthRecord) => {
    if (!expandedDomainId) return;
    const dnsView = dnsViews[expandedDomainId];
    if (!dnsView) return;
    setSetupRecord(record);
    setSetupMessage(null);
    try {
      const post = async (replaceMx: boolean) => {
        const res = await authFetch(`/api/domains/${dnsView.domain.id}/dns/setup`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ record, replaceMx }),
        });
        return {
          res,
          json: (await res.json()) as {
            domain?: Domain;
            dns?: DomainDnsView;
            error?: string;
            code?: string;
            records?: { content: string; priority: number }[];
          },
        };
      };
      let { res, json } = await post(false);
      if (confirmMxReplacement(res, json)) ({ res, json } = await post(true));
      if (!res.ok) throw new Error(json.error ?? t("domains.dnsSetupFailed"));
      if (json.domain && json.dns) {
        const updatedView = { domain: json.domain, dns: json.dns };
        setDnsViews((current) => ({
          ...current,
          [dnsView.domain.id]: updatedView,
        }));
      } else await loadDns(dnsView.domain.id);
      qc.invalidateQueries({ queryKey: ["domains"] });
    } catch (error) {
      setSetupMessage(error instanceof Error ? error.message : t("domains.dnsSetupFailed"));
    } finally {
      setSetupRecord(null);
    }
  };

  const inspectDomain = async () => {
    const normalized = hostname.toLowerCase().trim();
    if (skipDns || normalized.length < 3 || domainCheck?.hostname === normalized) return;

    setDomainChecking(true);
    setDomainCheckError(null);
    const result = await checkDomain(normalized);
    setDomainChecking(false);
    if (!result.ok || !result.domain) {
      setDomainCheck(null);
      setDomainCheckError(result.error ?? t("onboarding.domainCheckFailed"));
      return;
    }

    setDomainCheck(result.domain);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl md:text-3xl font-medium">{t("domains.title")}</h1>
          <p className="mt-1 text-sm text-neutral-500">
            {managesDns
              ? t("domains.descriptionManaged")
              : t("domains.descriptionManual")}
          </p>
        </div>
        <Dialog open={createOpen} onOpenChange={setCreateOpen}>
          <DialogTrigger asChild>
            <Button className={mobilePrimaryActionClass}>
              <Plus className="h-4 w-4" />
              {t("domains.new")}
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t("domains.addTitle")}</DialogTitle>
              <DialogDescription>
                {t("domains.addDescription")}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="hostname">{t("domains.hostname")}</Label>
                <Input
                  id="hostname"
                  value={hostname}
                  onChange={(e) => {
                    setHostname(e.target.value);
                    if (domainCheck?.hostname !== e.target.value.toLowerCase().trim()) {
                      setDomainCheck(null);
                    }
                  }}
                  onBlur={() => void inspectDomain()}
                  placeholder="example.com"
                />
              </div>
              <div className="flex items-center justify-between gap-4 rounded-xl bg-neutral-50 px-4 py-3">
                <div>
                  <Label htmlFor="skip-dns">{t("setup.skipDns")}</Label>
                  <p className="mt-1 text-xs leading-5 text-neutral-500">
                    {skipDns ? t("setup.skipDnsOn") : t("setup.skipDnsHint")}
                  </p>
                </div>
                <Switch
                  id="skip-dns"
                  checked={skipDns}
                  onCheckedChange={(checked) => {
                    setSkipDns(checked);
                    setDomainCheckError(null);
                  }}
                />
              </div>
              {!skipDns && (
                <>
              <div className="flex items-center justify-between gap-4 rounded-xl bg-neutral-50 px-4 py-3">
                <div>
                  <Label htmlFor="receiving-provider">{t("domains.receiveWith")}</Label>
                  <p className="mt-1 text-xs leading-5 text-neutral-500">
                    {receivingProvider === "cloudflare"
                      ? t("domains.receiveHintCloudflare")
                      : receivingProvider === "none"
                        ? t("domains.receiveHintNone")
                        : t("domains.providerHintLater")}
                  </p>
                </div>
                <select
                  id="receiving-provider"
                  value={receivingProvider}
                  onChange={(e) => setReceivingProvider(e.target.value as ReceivingProvider)}
                  className="h-9 shrink-0 rounded-md border border-neutral-200 bg-white px-3 text-sm"
                >
                  <option value="cloudflare">{t("domains.cloudflareRouting")}</option>
                  <option value="resend">Resend</option>
                  <option value="ses">Amazon SES</option>
                  <option value="none">{t("domains.notSelected")}</option>
                </select>
              </div>
              <div className="flex items-center justify-between gap-4 rounded-xl bg-neutral-50 px-4 py-3">
                <div>
                  <Label htmlFor="sending-provider">{t("domains.sendWith")}</Label>
                  <p className="mt-1 text-xs leading-5 text-neutral-500">
                    {domainChecking
                      ? t("setup.checkingCloudflare")
                      : sendingProvider === "cloudflare"
                        ? t("domains.sendHintCloudflare")
                        : sendingProvider === "none"
                          ? t("domains.sendHintNone")
                          : t("domains.providerHintLater")}
                  </p>
                </div>
                {domainChecking && <LoaderCircle className="h-4 w-4 shrink-0 animate-spin text-neutral-500" />}
                <select
                  id="sending-provider"
                  value={sendingProvider}
                  onChange={(e) => setSendingProvider(e.target.value as SendingProvider)}
                  className="h-9 shrink-0 rounded-md border border-neutral-200 bg-white px-3 text-sm"
                >
                  <option value="cloudflare">{t("domains.cloudflareSending")}</option>
                  <option value="resend">Resend</option>
                  <option value="ses">Amazon SES</option>
                  <option value="none">{t("domains.notSelected")}</option>
                </select>
              </div>
                </>
              )}
              {domainCheck && !skipDns && (
                <div className="flex items-center gap-3 rounded-xl bg-green-50 px-4 py-3 text-sm text-green-700">
                  <CheckCircle2 className="h-4 w-4" />
                  {t("setup.domainFound", { zone: domainCheck.zone.name })}
                </div>
              )}
              {domainCheckError && (
                <p className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">
                  {domainCheckError}
                </p>
              )}
              {create.isError && (
                <div className="space-y-3 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">
                  <p>{(create.error as Error).message}</p>
                  {!isMxConflictError(create.error) && (
                    <div className="space-y-2">
                      <p className="font-medium">
                        {t("domains.tokenPermissions")}
                      </p>
                      <ul className="list-disc space-y-1 pl-5">
                        <li>
                          {t("domains.tokenAccounts")}
                        </li>
                        <li>
                          {t("domains.tokenZones")}
                        </li>
                      </ul>
                    </div>
                  )}
                </div>
              )}
              <Button
                onClick={() => create.mutate()}
                disabled={!hostname || domainChecking || create.isPending}
              >
                {create.isPending ? t("onboarding.adding") : t("domains.addTitle")}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>
      <section className="space-y-3">
        {/* <div className="flex items-center justify-between">
					<span className="text-sm text-neutral-500">{(data?.domains ?? []).length} total</span>
				</div> */}
        {isLoading && (
          <SectionRowSkeleton />
        )}
        {!isLoading && (data?.domains ?? []).length === 0 && (
          <p className="rounded-2xl bg-white px-5 py-4 text-sm text-neutral-500">
            {t("domains.none")}
          </p>
        )}
        <List>
          {(data?.domains ?? []).map((d) => {
            const dns = data?.dns?.[d.id];
            return (
              <DomainItemCard
                key={d.id}
                dns={dns}
                dnsDetails={dnsViews[d.id]?.dns}
                onSendingProviderChange={changeSendingProvider}
                sendingProviderBusy={sendingBusy}
                sendingProviderMessage={expandedDomainId === d.id ? sendingMessage : null}
                onReceivingProviderChange={changeReceivingProvider}
                receivingProviderBusy={receivingBusy}
                receivingProviderMessage={expandedDomainId === d.id ? receivingMessage : null}
                onDnsChanged={refreshExpandedDns}
                dnsLoading={expandedDomainId === d.id && dnsLoading}
                dnsError={expandedDomainId === d.id ? dnsError : null}
                expanded={expandedDomainId === d.id}
                onToggleDns={toggleDns}
                onSetup={setupDns}
                setupRecord={setupRecord}
                setupMessage={setupMessage}
                item={d}
                remove={remove}
              />
            );
          })}
        </List>
      </section>
    </div>
  );
}
