/** Geometry of the inline message action row. Icon buttons are 32px and the row uses gap-2. */
export const INLINE_ACTION_WIDTH = 32;
export const INLINE_ACTION_GAP = 8;
export const INLINE_ACTION_DIVIDER_WIDTH = 1;
export const INLINE_ACTION_TRIGGER_WIDTH = 32;

export type VisibleActionCountInput = {
	/** Width of the row that holds the actions and the overflow trigger. */
	availableWidth: number;
	/** Group id of each action, in priority order. */
	groups: string[];
	actionWidth?: number;
	gap?: number;
	dividerWidth?: number;
	triggerWidth?: number;
};

/**
 * How many leading actions fit before the always-visible overflow trigger.
 * The trigger is reserved first, so a narrow row keeps only the menu. A group
 * divider is counted together with the first action of the next group, which
 * means it never renders without an action after it.
 */
export function getVisibleActionCount({
	availableWidth,
	groups,
	actionWidth = INLINE_ACTION_WIDTH,
	gap = INLINE_ACTION_GAP,
	dividerWidth = INLINE_ACTION_DIVIDER_WIDTH,
	triggerWidth = INLINE_ACTION_TRIGGER_WIDTH,
}: VisibleActionCountInput): number {
	if (!Number.isFinite(availableWidth) || availableWidth <= 0) return 0;

	let used = triggerWidth;
	let count = 0;
	for (let index = 0; index < groups.length; index += 1) {
		const startsGroup = index > 0 && groups[index] !== groups[index - 1];
		const width = gap + actionWidth + (startsGroup ? gap + dividerWidth : 0);
		if (used + width > availableWidth) break;
		used += width;
		count += 1;
	}
	return count;
}
