/**
 * Sequence sets (RFC 3501 `sequence-set`): numbers, `*`, `a:b` ranges, comma lists.
 * Parsed by hand and bounded: at most 1000 ranges, numbers of at most ten digits
 * and between 1 and 4294967295.
 */
export type SetRange = { from: number | "*"; to: number | "*" };

const MAX_RANGES = 1000;
const MAX_NUMBER = 4294967295;

function bound(text: string): number | "*" | null {
	if (text === "*") return "*";
	if (!text || text.length > 10) return null;
	for (let index = 0; index < text.length; index += 1) {
		const code = text.charCodeAt(index);
		if (code < 48 || code > 57) return null;
	}
	const value = Number(text);
	return value >= 1 && value <= MAX_NUMBER ? value : null;
}

/** Null when the text is not a valid sequence set. */
export function parseSequenceSet(text: string): SetRange[] | null {
	if (!text) return null;
	const parts = text.split(",");
	if (parts.length > MAX_RANGES) return null;
	const ranges: SetRange[] = [];
	for (const part of parts) {
		const [first, second, ...extra] = part.split(":");
		if (extra.length) return null;
		const from = bound(first);
		const to = second === undefined ? from : bound(second);
		if (from === null || to === null) return null;
		ranges.push({ from, to });
	}
	return ranges;
}

/** The ranges as ascending, non-overlapping `[low, high]` pairs, with `*` replaced by `max` (the largest number in use). */
export function resolveRanges(ranges: SetRange[], max: number): Array<[number, number]> {
	const pairs = ranges.map(({ from, to }): [number, number] => {
		const a = from === "*" ? max : from;
		const b = to === "*" ? max : to;
		return a <= b ? [a, b] : [b, a];
	});
	pairs.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
	const merged: Array<[number, number]> = [];
	for (const pair of pairs) {
		const last = merged[merged.length - 1];
		if (last && pair[0] <= last[1] + 1) last[1] = Math.max(last[1], pair[1]);
		else merged.push([pair[0], pair[1]]);
	}
	return merged;
}

/** First index in an ascending array whose value is at least `value`. */
export function lowerBound(sorted: number[], value: number): number {
	let low = 0;
	let high = sorted.length;
	while (low < high) {
		const middle = (low + high) >>> 1;
		if (sorted[middle] < value) low = middle + 1;
		else high = middle;
	}
	return low;
}

/** The sequence numbers (1-based, ascending) a message-number set selects out of `count` messages; numbers past the end select nothing. */
export function selectByNumber(ranges: SetRange[], count: number): number[] {
	const result: number[] = [];
	for (const [low, high] of resolveRanges(ranges, count)) for (let number = Math.max(low, 1); number <= Math.min(high, count); number += 1) result.push(number);
	return result;
}

/** The sequence numbers of the messages whose UIDs a UID set selects; `uids` is the ascending UID list of the folder. */
export function selectByUid(ranges: SetRange[], uids: number[]): number[] {
	const result: number[] = [];
	for (const [low, high] of resolveRanges(ranges, uids.length ? uids[uids.length - 1] : 0)) {
		for (let index = lowerBound(uids, low); index < uids.length && uids[index] <= high; index += 1) result.push(index + 1);
	}
	return result;
}

/** UIDs as a compact set text (`1:3,5`) for ESEARCH results. */
export function compactSet(numbers: number[]): string {
	const parts: string[] = [];
	for (let index = 0; index < numbers.length; ) {
		let end = index;
		while (end + 1 < numbers.length && numbers[end + 1] === numbers[end] + 1) end += 1;
		parts.push(end > index ? `${numbers[index]}:${numbers[end]}` : String(numbers[index]));
		index = end + 1;
	}
	return parts.join(",");
}
