import { createLucideIcon } from "lucide-react";

/** A send arrow with a clock, like Gmail's Scheduled icon. The arrow's lower edge stops
 * short of the clock so the two never overlap. */
export const ScheduledSendIcon = createLucideIcon("ScheduledSend", [
	["path", { d: "M12.5 16.25 3.5 20.75 6 12 3.5 3.25 21 12 19.25 12.9", key: "plane" }],
	["path", { d: "M6 12h6", key: "notch" }],
	["circle", { cx: "17", cy: "18", r: "4.5", key: "clock" }],
	["path", { d: "M17 16v2l1.25 1.25", key: "hands" }],
]);

/** Sun with its right half filled, like Gmail's "Tomorrow afternoon". */
export const AfternoonSunIcon = createLucideIcon("AfternoonSun", [
	["circle", { cx: "12", cy: "12", r: "4", key: "disc" }],
	["path", { d: "M12 8a4 4 0 0 1 0 8z", fill: "currentColor", key: "half" }],
	["path", { d: "M12 2v2", key: "r1" }],
	["path", { d: "M12 20v2", key: "r2" }],
	["path", { d: "m4.93 4.93 1.41 1.41", key: "r3" }],
	["path", { d: "m17.66 17.66 1.41 1.41", key: "r4" }],
	["path", { d: "M2 12h2", key: "r5" }],
	["path", { d: "M20 12h2", key: "r6" }],
	["path", { d: "m6.34 17.66-1.41 1.41", key: "r7" }],
	["path", { d: "m19.07 4.93-1.41 1.41", key: "r8" }],
]);
