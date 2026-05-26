"use client";

import { Search, X } from "lucide-react";
import { useMailSearch } from "./mail-search-context";

export function MailSearchInput() {
	const { query, setQuery } = useMailSearch();

	return (
		<div className="flex h-12 flex-1 max-w-3xl items-center gap-3 rounded-full bg-[#eaf1fb] px-4 text-neutral-600">
			<Search className="h-5 w-5 shrink-0" />
			<input
				value={query}
				onChange={(event) => setQuery(event.target.value)}
				placeholder='Search mail'
				className="h-full min-w-0 flex-1 bg-transparent text-[15px] text-neutral-800 outline-none placeholder:text-neutral-500"
			/>
			{query && (
				<button
					type="button"
					onClick={() => setQuery("")}
					className="rounded-full p-1 text-neutral-500 hover:bg-blue-100 hover:text-neutral-800"
					aria-label="Clear search"
				>
					<X className="h-4 w-4" />
				</button>
			)}
		</div>
	);
}
