import { nanoid } from "nanoid";

export function newId(prefix?: string): string {
	const id = nanoid();
	return prefix ? `${prefix}_${id}` : id;
}
