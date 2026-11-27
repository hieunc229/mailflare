import { parseProperty, type Property } from "@/lib/calendar/invite";

/**
 * Bounded reader for the content lines of iCalendar and vCard (RFC 5545 section 3.1, RFC 6350 section 3.2) in a PUT body,
 * which is hostile input. One linear pass: the body is already capped at 1 MiB by the caller, and
 * the number of properties, the nesting depth and the size of a parameter value are capped here. It never throws.
 */
export const MAX_PROPERTIES = 20_000;
export const MAX_DEPTH = 8;
export const MAX_PARAM_VALUE = 4096;

/** A property with the unfolded line it came from, so a merge can keep the lines it does not change byte for byte. */
export type ContentLine = Property & { raw: string };
export type Component = { name: string; props: ContentLine[]; children: Component[] };

/** The unfolded lines of a body (a continuation line starts with a space or tab), blank lines dropped; null above MAX_PROPERTIES lines. */
export function unfoldLines(text: string): string[] | null {
	const lines: string[] = [];
	let current: string | null = null;
	for (let start = 0; start <= text.length; ) {
		let end = text.indexOf("\n", start);
		if (end < 0) end = text.length;
		const line = text.slice(start, end > start && text[end - 1] === "\r" ? end - 1 : end);
		start = end + 1;
		if (current !== null && (line[0] === " " || line[0] === "\t")) current += line.slice(1);
		else {
			if (current) lines.push(current);
			current = line;
		}
		if (lines.length > MAX_PROPERTIES) return null;
	}
	if (current) lines.push(current);
	return lines;
}

/**
 * The one top-level component of a body (`VCALENDAR`, `VCARD`) with its properties and nested components, or null when the
 * body is not exactly that: unbalanced BEGIN/END, anything after the END, another top-level component, nesting deeper than
 * MAX_DEPTH, a parameter value over MAX_PARAM_VALUE, or more than MAX_PROPERTIES properties.
 */
export function readComponent(text: string, name: string): Component | null {
	const lines = unfoldLines(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
	if (!lines) return null;
	let root: Component | null = null;
	const stack: Component[] = [];
	let count = 0;
	for (const line of lines) {
		const property = parseProperty(line);
		if (!property) continue;
		if (++count > MAX_PROPERTIES) return null;
		if (Object.values(property.params).some((value) => value.length > MAX_PARAM_VALUE)) return null;
		if (property.name === "BEGIN") {
			const component: Component = { name: property.value.trim().toUpperCase(), props: [], children: [] };
			if (stack.length === 0) {
				if (root || component.name !== name) return null;
				root = component;
			} else {
				if (stack.length >= MAX_DEPTH) return null;
				stack[stack.length - 1].children.push(component);
			}
			stack.push(component);
		} else if (property.name === "END") {
			if (!stack.length || stack.pop()!.name !== property.value.trim().toUpperCase()) return null;
		} else if (stack.length) stack[stack.length - 1].props.push({ ...property, raw: line });
		else return null;
	}
	return root && !stack.length ? root : null;
}

/** First property of that name. */
export const firstProp = (component: Component, name: string): ContentLine | undefined => component.props.find((property) => property.name === name);
