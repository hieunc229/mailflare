"use client";

import { useEffect, useState } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import clsx from "clsx";
import { Check, ListFilter } from "@/components/icons";
import { useLanguage } from "@/components/language-provider";
import { DRIVE_CATEGORIES } from "@/lib/drive/category-names";
import type { DriveCategory } from "@/lib/drive/category-names";

/** Multi-select filter by kind of file (photos, videos, documents, others). */
export function DriveTypeFilter({ value: applied, onChange }: { value: DriveCategory[]; onChange: (next: DriveCategory[]) => void }) {
	const { t } = useLanguage();
	// Local copy so quick successive clicks build on each other while the URL update is still in flight.
	const [value, setValue] = useState(applied);
	const appliedKey = applied.join(",");
	useEffect(() => { setValue(appliedKey ? (appliedKey.split(",") as DriveCategory[]) : []); }, [appliedKey]);
	const update = (next: DriveCategory[]) => { setValue(next); onChange(next); };
	const labels: Record<DriveCategory, string> = { photos: t("drive.photos"), videos: t("drive.videos"), documents: t("drive.documents"), others: t("drive.others") };
	const active = value.length > 0;
	return (
		<DropdownMenu.Root>
			<DropdownMenu.Trigger asChild>
				<button type="button" aria-label={t("drive.typeFilter")} className={clsx("flex h-9 shrink-0 items-center gap-2 rounded-full border px-3 text-sm", active ? "border-blue-200 bg-blue-50 text-blue-800" : "border-neutral-200 text-neutral-700 hover:bg-neutral-100")}>
					<ListFilter size={16} />{t("drive.typeFilter")}{active && <span className="rounded-full bg-blue-600 px-1.5 text-xs text-white">{value.length}</span>}
				</button>
			</DropdownMenu.Trigger>
			<DropdownMenu.Portal>
				<DropdownMenu.Content align="end" sideOffset={6} className="z-[200] min-w-48 rounded-xl border border-neutral-200 bg-white p-1.5 shadow-xl">
					{DRIVE_CATEGORIES.map((category) => (
						<DropdownMenu.CheckboxItem
							key={category}
							checked={value.includes(category)}
							onCheckedChange={(checked) => update(checked ? [...value, category] : value.filter((entry) => entry !== category))}
							onSelect={(event) => event.preventDefault()}
							className="relative flex cursor-pointer items-center rounded-lg py-2 pl-8 pr-3 text-sm text-neutral-700 outline-none data-[highlighted]:bg-neutral-100"
						>
							<DropdownMenu.ItemIndicator className="absolute left-2.5"><Check size={14} className="text-blue-600" /></DropdownMenu.ItemIndicator>
							{labels[category]}
						</DropdownMenu.CheckboxItem>
					))}
					{active && (
						<>
							<DropdownMenu.Separator className="my-1 h-px bg-neutral-100" />
							<DropdownMenu.Item onSelect={() => update([])} className="cursor-pointer rounded-lg px-3 py-2 text-sm text-neutral-700 outline-none data-[highlighted]:bg-neutral-100">{t("drive.clearFilter")}</DropdownMenu.Item>
						</>
					)}
				</DropdownMenu.Content>
			</DropdownMenu.Portal>
		</DropdownMenu.Root>
	);
}
