"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import toast, { Toaster } from "react-hot-toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { confirmDestructive } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { List, ListRow } from "@/components/ui/list";
import { AlertTriangle, Check, Globe2, Loader2 } from "@/components/icons";
import { StatusBadge } from "./status-row";
import { authFetch } from "@/lib/auth/client";
import { DNS_CHECKED_EVENT } from "@/components/dns-skipped-banner";

/** Automatic DNS helper ("Add the missing records automatically") is hidden for now. */
const SHOW_AUTO_DNS = false;
type DomainItem = { id: string; hostname: string };
type DomainRecords = {
  hostname: string;
  registered: boolean;
  status: string;
  records: { record: string; type: string; name: string; value: string; priority: number | null; status: string; optional?: boolean }[];
  otherMx?: string[];
};

type DnsProvider = { id: string; label: string; fields: { key: string; label: string; secret?: boolean }[]; help: string; helpUrl: string };
type DnsHelperResult = { provider: string; zone: string; results: { record: string; type: string; name: string; status: "added" | "exists" | "failed"; error?: string }[] };

async function json<T>(response: Response): Promise<T> {
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? "Request failed");
  return body;
}

/**
 * Domains of a hosted workspace. Mail goes through the platform's provider for sending and receiving, so there is
 * nothing to choose: each domain lists the DNS records to publish at your DNS host, and a button re-checks them.
 */
export default function ManagedDomains() {
  const qc = useQueryClient();
  const [hostname, setHostname] = useState("");
  const [error, setError] = useState("");
  const { data, isLoading } = useQuery({
    queryKey: ["domains", "managed"],
    queryFn: async () => json<{ domains: DomainItem[]; limit: number | null }>(await authFetch("/api/domains")),
  });
  const limit = data?.limit ?? null;
  const used = data?.domains.length ?? 0;
  const atLimit = limit !== null && used >= limit;
  const add = useMutation({
    mutationFn: async (name: string) => json(await authFetch("/api/domains", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ hostname: name, skipDns: true }) })),
    onSuccess: () => { setHostname(""); setError(""); void qc.invalidateQueries({ queryKey: ["domains", "managed"] }); },
    onError: (e) => setError(e instanceof Error ? e.message : "Could not continue setup"),
  });
  const remove = useMutation({
    mutationFn: async (id: string) => json(await authFetch(`/api/domains/${id}`, { method: "DELETE" })),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["domains", "managed"] }),
    onError: (e) => setError(e instanceof Error ? e.message : "Could not remove the domain"),
  });

  return (
    <div className="mx-auto w-full max-w-4xl space-y-6 p-4 md:p-8">
      <Toaster position="bottom-left" containerClassName="text-sm" />
      <div>
        <h1 className="text-2xl font-semibold">Domains{data ? ` (${used}${limit !== null ? `/${limit}` : ""})` : ""}</h1>
        <p className="mt-1 text-sm text-neutral-500">Publish these DNS records at your DNS host so mail can be sent and received for each domain.</p>
      </div>
      <form
        className="flex gap-2"
        onSubmit={(event) => { event.preventDefault(); if (hostname.trim()) add.mutate(hostname.trim().toLowerCase()); }}
      >
        <Input value={hostname} onChange={(event) => setHostname(event.target.value)} placeholder="example.com" autoCapitalize="none" spellCheck={false} />
        <Button disabled={add.isPending || !hostname.trim() || atLimit}>{add.isPending ? "Adding…" : "Add domain"}</Button>
      </form>
      {atLimit && <p className="text-xs text-neutral-500">Your plan includes {limit} domain{limit === 1 ? "" : "s"}. Upgrade your plan to add more.</p>}
      {error && <p className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>}
      {isLoading ? <p className="text-sm text-neutral-500">Loading…</p> : data?.domains.length === 0 ? <p className="text-sm text-neutral-500">No domains yet.</p> : (
        <List>
          {data?.domains.map((domain) => (
            <DomainRecordsCard key={domain.id} domain={domain} onRemove={async () => {
              if (await confirmDestructive({ message: `Remove ${domain.hostname}? Its mailboxes and mail are deleted.`, requireText: domain.hostname })) remove.mutate(domain.id);
            }} />
          ))}
        </List>
      )}
    </div>
  );
}

function DomainRecordsCard({ domain, onRemove }: { domain: DomainItem; onRemove: () => void }) {
  const qc = useQueryClient();
  const key = ["domains", "managed", "records", domain.id];
  const { data, isLoading, error } = useQuery({ queryKey: key, queryFn: async () => {
    const records = await json<DomainRecords>(await authFetch(`/api/domains/${domain.id}/records`));
    window.dispatchEvent(new Event(DNS_CHECKED_EVENT));
    return records;
  } });
  const verify = useMutation({
    mutationFn: async () => json<DomainRecords>(await authFetch(`/api/domains/${domain.id}/records`, { method: "POST" })),
    onSuccess: (fresh) => {
      qc.setQueryData(key, fresh);
      window.dispatchEvent(new Event(DNS_CHECKED_EVENT));
    },
  });
  const register = useMutation({
    mutationFn: async () => json<DomainRecords>(await authFetch(`/api/domains/${domain.id}/records`, { method: "PUT" })),
    onSuccess: (fresh) => qc.setQueryData(key, fresh),
  });
  const [helperOpen, setHelperOpen] = useState(false);
  const [providerId, setProviderId] = useState("");
  const [creds, setCreds] = useState<Record<string, string>>({});
  const providers = useQuery({ queryKey: ["domains", "dns-providers"], enabled: helperOpen, queryFn: async () => (await json<{ providers: DnsProvider[] }>(await authFetch(`/api/domains/${domain.id}/dns-provider`))).providers });
  const provider = providers.data?.find((p) => p.id === providerId);
  const autoAdd = useMutation({
    mutationFn: async () => json<DnsHelperResult>(await authFetch(`/api/domains/${domain.id}/dns-provider`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider: providerId, credentials: creds }) })),
    onSuccess: () => { setCreds({}); verify.mutate(); },
  });
  const missing = data?.registered === false;
  const verified = data?.status === "verified";
  const done = data?.records.filter((record) => record.status === "verified").length ?? 0;
  const ok = (status: string) => status === "verified";
  return (
    <ListRow className="flex-col items-stretch gap-3 max-md:rounded-none max-md:border-b max-md:border-neutral-100 max-md:px-0 max-md:py-4 max-md:last:border-b-0">
      <div className="flex flex-wrap items-center gap-3 md:gap-4">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-neutral-100 text-neutral-600"><Globe2 className="h-5 w-5" /></span>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold text-neutral-900">{domain.hostname}</h2>
          {data && !missing && (
            <Badge variant={verified ? "success" : "secondary"} className="mt-1 gap-1">
              {verified ? <Check className="h-3 w-3 text-green-600" /> : <AlertTriangle className="h-3 w-3 text-amber-500" />}
              {verified ? "Verified" : `${done}/${data.records.length} records done`}
            </Badge>
          )}
        </div>
        {!missing && <Button size="sm" variant="outline" disabled={verify.isPending} onClick={() => verify.mutate()}>{verify.isPending ? "Checking…" : "Check DNS"}</Button>}
        <Button size="sm" variant="ghost" className="text-red-600" onClick={onRemove}>Remove</Button>
      </div>
      {missing && (
        <div className="flex flex-col items-start gap-2">
          <p className="text-sm text-amber-700">This domain is not connected yet, so mail can't be sent or received for it.</p>
          <Button disabled={register.isPending} onClick={() => register.mutate()}>
            {register.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {register.isPending ? "Connecting…" : "Connect your domain to continue"}
          </Button>
        </div>
      )}
      {register.error && <p className="text-sm text-red-600">{register.error instanceof Error ? register.error.message : "Could not connect the domain"}</p>}
      {verify.error && <p className="text-sm text-red-600">{verify.error instanceof Error ? verify.error.message : "Check failed"}</p>}
      {data && !missing && !verified && <p className="text-xs text-neutral-500">Add the records marked pending at the DNS host for {domain.hostname} (where you registered it or manage its nameservers), then press Check DNS. Changes can take a few minutes to appear.</p>}
      {!!data?.otherMx?.length && (
        <div role="alert" className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <p className="font-semibold">{domain.hostname} already receives email at {data.otherMx.join(", ")}.</p>
          <p className="mt-1">Changing the MX record moves all new mail for this domain here. First create a mailbox for every address you use, then add our MX record and remove the old ones. To keep your current email, use a different domain or subdomain.</p>
        </div>
      )}
      {SHOW_AUTO_DNS && data && !missing && !verified && (
        <div className="space-y-3">
          {!helperOpen ? <Button size="sm" variant="outline" onClick={() => setHelperOpen(true)}>Add the missing records automatically</Button> : (
            <form className="space-y-3 rounded-xl border border-neutral-200 p-4" autoComplete="off" onSubmit={(event) => { event.preventDefault(); if (provider) autoAdd.mutate(); }}>
              <div className="flex items-center gap-2">
                <select className="h-9 w-full rounded-md border border-neutral-200 bg-transparent px-3 text-sm" value={providerId} onChange={(event) => { setProviderId(event.target.value); setCreds({}); autoAdd.reset(); }}>
                  <option value="">Where is the DNS of {domain.hostname} managed?</option>
                  {providers.data?.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
                </select>
                {providers.isLoading && <Loader2 className="h-4 w-4 animate-spin" />}
              </div>
              {provider ? (
                <>
                  <p className="text-xs text-neutral-500">{provider.help} <a className="underline" href={provider.helpUrl} target="_blank" rel="noreferrer">Open {provider.label}</a>. Your keys are used once to add the records and are never saved.</p>
                  {provider.fields.map((field) => (
                    <Input key={field.key} type={field.secret ? "password" : "text"} placeholder={field.label} autoComplete="off" spellCheck={false} value={creds[field.key] ?? ""} onChange={(event) => setCreds({ ...creds, [field.key]: event.target.value })} />
                  ))}
                  <Button disabled={autoAdd.isPending || provider.fields.some((f) => !creds[f.key]?.trim())}>
                    {autoAdd.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    {autoAdd.isPending ? "Adding records…" : `Add records to ${provider.label}`}
                  </Button>
                </>
              ) : <p className="text-xs text-neutral-500">Host not listed? Add the records below by hand, or move the domain's nameservers to Cloudflare (free) and pick Cloudflare.</p>}
              {autoAdd.error && <p className="text-sm text-red-600">{autoAdd.error instanceof Error ? autoAdd.error.message : "Could not add the records"}</p>}
              {autoAdd.data && (
                <ul className="space-y-1 text-xs">
                  {autoAdd.data.results.map((r, i) => (
                    <li key={i} className={r.status === "failed" ? "text-red-600" : "text-green-700"}>
                      {r.status === "added" ? "Added" : r.status === "exists" ? "Already there" : "Failed"}: {r.type} {r.name}{r.error ? ` (${r.error})` : ""}
                    </li>
                  ))}
                  <li className="text-neutral-500">Checked again just now; DNS can take a few minutes to show.</li>
                </ul>
              )}
            </form>
          )}
        </div>
      )}
      {isLoading ? <p className="text-sm text-neutral-500">Loading records…</p> : error ? <p className="text-sm text-red-600">{error instanceof Error ? error.message : "Could not load records"}</p> : data && data.records.length > 0 && (
        <div>
          <div className={`${RECORD_GRID} hidden px-4 pb-1 text-xs font-medium text-neutral-500 sm:grid`}>
            <span className="w-7" /><span>Type</span><span>Name</span><span>Priority</span><span>Value</span>
          </div>
          <ul className="space-y-2">
            {data.records.map((record, index) => (
              <li key={`${record.type}-${record.name}-${index}`} className={`${RECORD_GRID} rounded-xl px-4 py-3 text-sm ${ok(record.status) ? "bg-green-50" : "bg-red-50"}`}>
                <StatusBadge ok={ok(record.status)} />
                <span className="min-w-0">
                  <span className="block font-medium text-neutral-900">{record.type}</span>
                  <span className="block text-xs text-neutral-500">{record.record}{record.optional ? " (recommended)" : ""}</span>
                </span>
                <span className="min-w-0 break-all"><Copy text={record.name} /></span>
                <span className="text-neutral-700">{record.priority ?? "—"}</span>
                <span className="min-w-0 break-all"><Copy text={record.value} /></span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </ListRow>
  );
}

const RECORD_GRID = "grid items-start gap-3 sm:grid-cols-[auto_5rem_minmax(0,1fr)_4rem_minmax(0,1fr)]";

function Copy({ text }: { text: string }) {
  return (
    <button type="button" title="Copy" className="cursor-pointer text-left text-neutral-700 hover:text-blue-700" onClick={() => { void navigator.clipboard?.writeText(text).then(() => toast.success("Copied"), () => toast.error("Could not copy")); }}>
      {text}
    </button>
  );
}
