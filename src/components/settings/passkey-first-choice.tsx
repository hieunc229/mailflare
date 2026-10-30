"use client";

import { AlertTriangle, Info, KeyRound, ShieldCheck } from "@/components/icons";
import { useLanguage } from "@/components/language-provider";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export type PasskeyPolicyChoice = "passkey-only" | "password-and-passkey" | "keep";

type Option = {
	id: PasskeyPolicyChoice;
	title: string;
	hint: string;
	notes?: string[];
	icon: typeof KeyRound;
	iconClass: string;
};

/**
 * Asks what should happen to password sign-in right after the first passkey
 * is enrolled. The options depend on whether an authenticator app is set up.
 */
export function PasskeyFirstChoice({
	open,
	totpEnabled,
	onOpenChange,
	onChoose,
	context = "first-passkey",
	busy = false,
}: {
	open: boolean;
	totpEnabled: boolean;
	onOpenChange: (open: boolean) => void;
	onChoose: (choice: PasskeyPolicyChoice) => void;
	context?: "first-passkey" | "add-password";
	busy?: boolean;
}) {
	const { t } = useLanguage();
	const addingPassword = context === "add-password";

	const options: Option[] = totpEnabled && !addingPassword
		? [
			{
				id: "passkey-only",
				title: t("passkey.choicePasskeyOnly"),
				hint: t("passkey.choiceRemovesPasswordAndCodes"),
				notes: [t("passkey.choiceTwoSteps")],
				icon: KeyRound,
				iconClass: "text-neutral-500",
			},
			{
				id: "keep",
				title: t("passkey.choiceKeepCurrent"),
				hint: t("passkey.choiceKeepCurrentHint"),
				icon: ShieldCheck,
				iconClass: "text-green-600",
			},
		]
		: [
			{
				id: "passkey-only",
				title: t(addingPassword ? "passkey.choiceKeepPasskeysOnly" : "passkey.choicePasskeyOnly"),
				hint: t(addingPassword ? "passkey.choiceDiscardPassword" : "passkey.choiceRemovesPassword"),
				icon: KeyRound,
				iconClass: "text-neutral-500",
			},
			{
				id: "password-and-passkey",
				title: t("passkey.choicePasswordAndPasskey"),
				hint: t(totpEnabled ? "twoStep.requireDescription" : "passkey.choicePasswordAndPasskeyHint"),
				icon: ShieldCheck,
				iconClass: "text-green-600",
			},
			{
				id: "keep",
				title: t("passkey.choiceKeepPasswordOnly"),
				hint: t("passkey.choiceKeepPasswordOnlyHint"),
				icon: AlertTriangle,
				iconClass: "text-amber-500",
			},
		];

	return (
		<Dialog open={open} onOpenChange={(next) => { if (next) onOpenChange(true); }}>
			<DialogContent
				className="sm:max-w-[480px]"
				showCloseButton={false}
				onEscapeKeyDown={(event) => event.preventDefault()}
				onInteractOutside={(event) => event.preventDefault()}
				aria-busy={busy}
			>
				<DialogHeader>
					<DialogTitle>{t("passkey.firstChoiceTitle")}</DialogTitle>
					<DialogDescription>{t(addingPassword ? "passkey.passwordChoiceDescription" : "passkey.firstChoiceDescription")}</DialogDescription>
				</DialogHeader>
				<p className="mb-4 flex items-start gap-2 text-xs leading-5 text-neutral-500">
					<Info className="mt-0.5 h-4 w-4 shrink-0" />
					<span>{t("passkey.choiceRecoveryNote")}</span>
				</p>
				<div className="space-y-2">
					{options.map((option) => (
						<button
							key={option.id}
							type="button"
							onClick={() => onChoose(option.id)}
							disabled={busy}
							className="flex w-full items-start gap-3 rounded-2xl border border-neutral-200 p-3 text-left transition-colors hover:border-neutral-300 hover:bg-neutral-50"
						>
							<option.icon className={`mt-0.5 h-4 w-4 shrink-0 ${option.iconClass}`} />
							<span className="min-w-0">
								<span className="block text-sm font-medium text-neutral-900">{option.title}</span>
								<span className="mt-0.5 block text-sm leading-5 text-neutral-500">{option.hint}</span>
								{option.notes?.map((note) => (
									<span key={note} className="mt-1 flex items-start gap-1.5 text-xs leading-5 text-neutral-400">
										<Info className="mt-0.5 h-3 w-3 shrink-0" />
										{note}
									</span>
								))}
							</span>
						</button>
					))}
				</div>
			</DialogContent>
		</Dialog>
	);
}
