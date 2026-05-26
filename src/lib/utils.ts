import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
	return twMerge(clsx(inputs));
}

export function slugify(value: string): string {
	return value
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

export function parseAddress(address: string): { local: string; domain: string } | null {
	const normalized = address.trim().match(/<([^>]+)>$/)?.[1] ?? address.trim();
	const match = normalized.match(/^([^@\s]+)@([^@\s]+)$/);
	if (!match) return null;
	return { local: match[1].toLowerCase(), domain: match[2].toLowerCase() };
}
