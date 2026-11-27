"use client";

import { AlertCircle } from "@/components/icons";
import { useLanguage } from "@/components/language-provider";
import type { BookingRoomProblem } from "./room-problem";

/** On a booking type's card: plain text saying why its public page offers no times, so the owner is not left to hear it from a visitor. */
export function BookingPageNotice({ problem, id }: { problem: BookingRoomProblem | null; id?: string }) {
	const { t } = useLanguage();
	if (!problem) return null;
	return <p id={id} className="mt-1 flex items-start gap-2 text-sm text-red-700"><AlertCircle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />{t(`booking.pageDark.${problem}` as never)}</p>;
}
