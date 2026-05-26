"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { Badge } from "@/components/ui/badge";
import {
  Check,
  X,
  AlertTriangle,
  ArrowRight,
  Globe2,
  Plus,
  Trash2,
} from "lucide-react";
import type { DnsRecord, DnsStatusSummary, Domain } from "./types";

export default function DomainsPage() {
  const qc = useQueryClient();
  const [hostname, setHostname] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [dnsView, setDnsView] = useState<{
    domain: Domain;
    dns: unknown;
  } | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["domains"],
    queryFn: async () => {
      const res = await fetch("/api/domains?includeDns=true");
      return (await res.json()) as {
        domains: Domain[];
        dns: Record<string, DnsStatusSummary>;
      };
    },
  });

  const create = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/domains", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          hostname,
          enableRouting: true,
          enableSending: true,
        }),
      });
      const json = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(json.error ?? "Failed");
      return json;
    },
    onSuccess: () => {
      setHostname("");
      setCreateOpen(false);
      qc.invalidateQueries({ queryKey: ["domains"] });
    },
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/domains/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to remove");
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["domains"] }),
  });

  const loadDns = async (id: string) => {
    const res = await fetch(`/api/domains/${id}/dns`);
    const json = (await res.json()) as { domain: Domain; dns: unknown };
    if (res.ok) setDnsView(json);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Domains</h1>
          <p className="mt-1 text-sm text-neutral-500">
            Domains must be on your Cloudflare account. Adding a domain enables
            Email Routing and Email Sending DNS automatically.
          </p>
        </div>
        <Dialog open={createOpen} onOpenChange={setCreateOpen}>
          <DialogTrigger asChild>
            <Button>
              <Plus className="h-4 w-4" />
              New domain
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Add domain</DialogTitle>
              <DialogDescription>
                Provision Cloudflare routing and sending DNS for a zone in your
                account.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="hostname">Hostname</Label>
                <Input
                  id="hostname"
                  value={hostname}
                  onChange={(e) => setHostname(e.target.value)}
                  placeholder="example.com"
                />
              </div>
              {create.isError && (
                <p className="text-sm text-red-600">
                  {(create.error as Error).message}
                </p>
              )}
              <Button
                onClick={() => create.mutate()}
                disabled={!hostname || create.isPending}
              >
                {create.isPending ? "Adding..." : "Add domain"}
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
          <p className="rounded-lg border border-neutral-200 bg-white px-4 py-3 text-sm text-neutral-500">
            Loading DNS status...
          </p>
        )}
        {!isLoading && (data?.domains ?? []).length === 0 && (
          <p className="rounded-lg border border-neutral-200 bg-white px-4 py-3 text-sm text-neutral-500">
            No domains yet
          </p>
        )}
        <div className="grid gap-3 md:grid-cols-2">
          {(data?.domains ?? []).map((d) => {
            const dns = data?.dns?.[d.id];
            return (
              <div
                key={d.id}
                className="flex min-h-36 flex-col gap-3 rounded-lg border border-neutral-200 bg-white p-4 shadow-sm shadow-neutral-100"
              >
                <div className="flex items-start gap-3">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-neutral-100 text-neutral-600">
                    <Globe2 className="h-5 w-5" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <span className="block truncate font-mono text-sm font-semibold text-neutral-900">
                      {d.hostname}
                    </span>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <Badge
                        variant={
                          d.status === "active" ? "success" : "secondary"
                        }
                      >
                        {d.status}
                      </Badge>
                      {d.routingEnabled && (
                        <Badge variant="outline">routing</Badge>
                      )}
                      {d.sendingEnabled && (
                        <Badge variant="outline">sending</Badge>
                      )}
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => loadDns(d.id)}
                    >
                      DNS
                    </Button>
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={() => remove.mutate(d.id)}
                      disabled={remove.isPending}
                      aria-label={`Remove ${d.hostname}`}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
                {dns && (
                  <div className="flex flex-wrap items-center gap-3 text-xs">
                    <span className="flex items-center gap-1 text-neutral-500">
                      Routing{" "}
                      {dns.routing.configured ? (
                        <Check className="h-3.5 w-3.5 text-green-600" />
                      ) : (
                        <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
                      )}
                    </span>
                    {dns.routing.missing.length > 0 && (
                      <span className="text-red-600 flex items-center gap-1">
                        <X className="h-3 w-3" />
                        Missing: {dns.routing.missing.join(", ")}
                      </span>
                    )}
                    <span className="text-neutral-300">|</span>
                    <span className="flex items-center gap-1 text-neutral-500">
                      Sending{" "}
                      {dns.sending.configured ? (
                        <Check className="h-3.5 w-3.5 text-green-600" />
                      ) : (
                        <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
                      )}
                    </span>
                    {dns.sending.records.length > 0 && (
                      <span className="text-neutral-500">
                        {dns.sending.records.join(", ")}
                      </span>
                    )}
                    <button
                      onClick={() => loadDns(d.id)}
                      className="flex items-center gap-0.5 text-blue-600 hover:text-blue-800"
                    >
                      <ArrowRight className="h-3 w-3" />
                      details
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>
      {dnsView && (
        <Card>
          <CardHeader>
            <CardTitle>DNS — {dnsView.domain.hostname}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 text-xs font-mono">
            <div>
              <p className="font-sans font-medium text-sm mb-2">
                Email Routing
              </p>
              <pre className="overflow-auto bg-neutral-50 dark:bg-neutral-900 p-3 rounded-md">
                {JSON.stringify(
                  (dnsView.dns as { routing: unknown }).routing,
                  null,
                  2,
                )}
              </pre>
            </div>
            <div>
              <p className="font-sans font-medium text-sm mb-2">
                Email Sending
              </p>
              <pre className="overflow-auto bg-neutral-50 dark:bg-neutral-900 p-3 rounded-md">
                {JSON.stringify(
                  (dnsView.dns as { sending: DnsRecord[] }).sending,
                  null,
                  2,
                )}
              </pre>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
