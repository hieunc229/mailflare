"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { authFetch } from "@/lib/auth/client";

export type AddressCheck = { defaultHost: string; customHost: string | null; status: "none" | "ok" | "pending" | "error"; found: string[] };

/** The DNS check of the workspace's optional second address (set on the Branding page). */
export function WorkspaceAddressCheck({ initial }: { initial: AddressCheck }) {
  const [data, setData] = useState(initial);
  const [busy, setBusy] = useState(false);
  if (!data.customHost) return null;
  async function recheck() {
    setBusy(true);
    const res = await authFetch("/api/workspace/address").catch(() => null);
    if (res?.ok) setData((await res.json()) as AddressCheck);
    setBusy(false);
  }
  return (
    <section className="rounded-xl border border-neutral-200 p-4">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="min-w-0 flex-1 truncate font-semibold">Workspace address: {data.customHost}</h2>
        <Badge variant={data.status === "ok" ? "success" : "secondary"}>{data.status === "ok" ? "Verified" : data.status === "error" ? "Could not check" : "Pending"}</Badge>
        <Button size="sm" variant="outline" disabled={busy} onClick={recheck}>{busy ? "Checking…" : "Check DNS"}</Button>
      </div>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead className="text-neutral-500"><tr><th className="py-1 pr-3 font-medium">Type</th><th className="py-1 pr-3 font-medium">Name</th><th className="py-1 font-medium">Value</th></tr></thead>
          <tbody><tr><td className="py-2 pr-3 font-medium">CNAME</td><td className="break-all py-2 pr-3">{data.customHost}</td><td className="break-all py-2">{data.defaultHost}</td></tr></tbody>
        </table>
      </div>
      <p className="mt-3 text-xs text-neutral-500">Your workspace also opens at {data.defaultHost}, which always works. {data.status === "pending" && data.found.length ? `Currently points to ${data.found.join(", ")}.` : ""}</p>
    </section>
  );
}
