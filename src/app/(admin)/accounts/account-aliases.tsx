"use client";

import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import type { AccountAliasesProps } from "./types";

export function AccountAliases({ domains, domainId, username, useAllDomains, onUseAllDomainsChange, aliases, onAliasesChange }: AccountAliasesProps) {
	const availableDomains = domains.filter((domain) => domain.status === "active");
	return (
		<div className="space-y-4 border-t border-neutral-100 pt-4">
			<label className="flex items-start gap-3 rounded-xl bg-neutral-50 p-4">
				<Checkbox checked={useAllDomains} onChange={(event) => onUseAllDomainsChange(event.target.checked)} />
				<span>
					<span className="block text-sm font-medium">Use all domains</span>
					<span className="mt-1 block text-sm text-neutral-500">
						Use this username on every available domain, including domains added later.
						When off, only the primary address and the aliases below are assigned.
					</span>
				</span>
			</label>
			<div className="space-y-3">
				<div>
					<p className="text-sm font-medium">Additional aliases <span className="font-normal text-neutral-500">(optional)</span></p>
					<p className="mt-1 text-sm text-neutral-500">These addresses share the new account’s inbox and can also be used to send mail.</p>
				</div>
				{aliases.map((alias, index) => (
					<div key={alias.id} className="flex items-center gap-2">
						<div className="flex min-w-0 flex-1 items-center gap-1 rounded-md border border-neutral-200 bg-white">
							<Input
								aria-label={`Alias ${index + 1} username`}
								value={alias.localPart}
								onChange={(event) => onAliasesChange(aliases.map((item) => item.id === alias.id ? { ...item, localPart: event.target.value } : item))}
								placeholder="username"
								className="min-w-0 flex-1 rounded-none border-0 shadow-none"
								pattern="[a-zA-Z0-9._%+\-]+"
								maxLength={64}
								required
							/>
							<span className="text-sm text-neutral-400">@</span>
							<Select
								aria-label={`Alias ${index + 1} domain`}
								value={alias.domainId}
								onChange={(event) => onAliasesChange(aliases.map((item) => item.id === alias.id ? { ...item, domainId: event.target.value } : item))}
								containerClassName="min-w-0 flex-1 self-stretch rounded-none border-0 px-0"
								className="min-w-0 bg-transparent px-2 text-sm"
								required
							>
								{availableDomains.map((domain) => <option key={domain.id} value={domain.id}>{domain.hostname}</option>)}
							</Select>
						</div>
						<Button type="button" variant="ghost" size="sm" className="h-10 w-10 shrink-0 p-0" aria-label={`Remove alias ${index + 1}`} onClick={() => onAliasesChange(aliases.filter((item) => item.id !== alias.id))}>
							<Trash2 className="h-4 w-4" />
						</Button>
					</div>
				))}
				<Button type="button" variant="outline" disabled={!availableDomains.length || aliases.length >= 50} onClick={() => onAliasesChange([
					...aliases,
					{ id: crypto.randomUUID(), localPart: username.trim(), domainId: (availableDomains.find((domain) => domain.id !== domainId) ?? availableDomains[0]).id },
				])}>
					<Plus className="h-4 w-4" /> Add alias
				</Button>
			</div>
		</div>
	);
}
