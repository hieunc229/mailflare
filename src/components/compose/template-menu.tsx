"use client";

import { useEffect, useState } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { ChevronRight, FileText, Plus, Trash2 } from "@/components/icons";
import { useLanguage } from "@/components/language-provider";
import { authFetch } from "@/lib/auth/client";
import { textToHtml } from "./rich-text-utils";
import type { ComposeTemplate, TemplateMenuProps } from "./template-types";

const itemClass = "flex cursor-pointer items-center rounded-md px-3 py-2 outline-none hover:bg-neutral-100 focus:bg-neutral-100";

export function TemplateMenu({ onApply, onNew }: TemplateMenuProps) {
	const { t } = useLanguage();
	const [templates, setTemplates] = useState<ComposeTemplate[]>([]);

	useEffect(() => {
		void authFetch("/api/templates", { cache: "no-store" })
			.then(async (response) => {
				if (response.ok) setTemplates(((await response.json()) as { templates: ComposeTemplate[] }).templates);
			})
			.catch(() => {});
	}, []);
	async function remove(id: string) {
		const response = await authFetch(`/api/templates/${id}`, { method: "DELETE" });
		if (response.ok) setTemplates((current) => current.filter((template) => template.id !== id));
	}

	return (
		<DropdownMenu.Sub>
				<DropdownMenu.SubTrigger className={`${itemClass} justify-between data-[state=open]:bg-neutral-100`}>
					<span className="flex items-center"><FileText className="mr-2 h-4 w-4" />{t("template.menu")}</span>
					<ChevronRight className="ml-4 h-4 w-4 text-neutral-400" />
				</DropdownMenu.SubTrigger>
				<DropdownMenu.Portal>
					<DropdownMenu.SubContent
						sideOffset={4}
						className="z-50 flex max-h-80 w-64 flex-col rounded-lg border border-neutral-200 bg-white p-1 text-sm shadow-lg"
					>
						<div className="min-h-0 flex-1 overflow-y-auto">
							{templates.length === 0 && <p className="px-3 py-2 text-xs text-neutral-500">{t("template.none")}</p>}
							{templates.map((template) => (
								<div key={template.id} className="flex items-center gap-1">
									<DropdownMenu.Item
										onSelect={() => onApply({ title: template.subject ?? "", html: template.htmlBody ?? textToHtml(template.textBody ?? "") })}
										className={`${itemClass} min-w-0 flex-1`}
									>
										<span className="whitespace-normal break-words">{template.subject || t("template.untitled")}</span>
									</DropdownMenu.Item>
									<DropdownMenu.Item
										aria-label={t("template.delete")}
										onSelect={(event) => { event.preventDefault(); void remove(template.id); }}
										className="flex shrink-0 cursor-pointer items-center rounded p-2 text-neutral-500 outline-none hover:text-red-600 data-[highlighted]:bg-neutral-100 data-[highlighted]:text-red-600"
									>
										<Trash2 className="h-3.5 w-3.5" />
									</DropdownMenu.Item>
								</div>
							))}
						</div>
						<DropdownMenu.Separator className="my-1 h-px bg-neutral-100" />
						<DropdownMenu.Item onSelect={onNew} className={`${itemClass} text-blue-600`}>
							<Plus className="mr-2 h-4 w-4" />{t("template.new")}
						</DropdownMenu.Item>
					</DropdownMenu.SubContent>
				</DropdownMenu.Portal>
		</DropdownMenu.Sub>
	);
}
