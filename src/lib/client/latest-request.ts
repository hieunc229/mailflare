/**
 * Client-side ordering guard for a list that a GET fills and a mutation changes.
 *
 * A list GET that was already on the wire when a mutation lands can still
 * resolve afterwards, carrying the pre-mutation snapshot. It would then
 * repaint rows the mutation just removed (or revert fields it just set).
 *
 * This is the counter the app already uses per view (`requestNumber` in
 * `useMessages`, `loadVersion` in `useMessageThread`, `loadId` in the mailbox
 * provider), lifted into one place so list screens share it:
 *
 * - `begin()` opens a load. Only the newest token may write state, so when two
 *   loads overlap the older response is dropped whatever order they settle in.
 * - `invalidate()` retires every token in flight, for mutations that write
 *   their own authoritative result instead of starting a new load.
 */
export type LatestRequestGate = {
	begin(): number;
	isCurrent(token: number): boolean;
	invalidate(): void;
};

export function createLatestRequestGate(): LatestRequestGate {
	let latest = 0;
	return {
		begin: () => ++latest,
		isCurrent: (token) => token === latest,
		invalidate: () => {
			latest += 1;
		},
	};
}
