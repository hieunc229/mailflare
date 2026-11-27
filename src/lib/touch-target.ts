/**
 * Invisible 44x44 hit area for coarse pointers (WCAG 2.5.8 floor is 24px, 44px is the touch
 * recommendation). It is a centred ::before, so the visible size and the layout stay the
 * same on desktop and in dense rows. The host element must be positioned (`relative`).
 *
 * Overlap: the area overhangs the visible box by (44 - size)/2 per side, and neighbours closer
 * than that lose taps to the later (or only positioned) one, so give coarse rows
 * `pointer-coarse:gap-*` of at least that. Bare icons use Button size `icon`, which has a real
 * 44px box on coarse pointers. Parents with `overflow-hidden` clip the area.
 */
export const touchTarget =
	"pointer-coarse:before:absolute pointer-coarse:before:left-1/2 pointer-coarse:before:top-1/2 pointer-coarse:before:size-full pointer-coarse:before:min-h-11 pointer-coarse:before:min-w-11 pointer-coarse:before:-translate-x-1/2 pointer-coarse:before:-translate-y-1/2 pointer-coarse:before:content-['']";
