import { getServerTranslator } from "@/lib/i18n/server";
import { PasswordSettings } from "@/components/settings/password-settings";
import { PasskeySettings } from "@/components/settings/passkey-settings";
import { TwoStepSettings } from "@/components/settings/two-step-settings";
import { DeviceSettings } from "@/components/settings/device-settings";

export default async function SecuritySettingsPage() {
	const t = await getServerTranslator();
	return <div className="space-y-8 py-4">
		<section className="space-y-4">
			<div>
				<h1 className="text-xl font-semibold text-neutral-900">{t("settingsPage.security.title")}</h1>
				<p className="mt-1 text-sm text-neutral-500">{t("settingsPage.security.description")}</p>
			</div>
			<div className="space-y-6 rounded-3xl bg-white p-6">
				<div>
					<h2 className="text-lg font-semibold text-neutral-900">{t("signIn.methodsTitle")}</h2>
					<p className="mt-1 text-sm text-neutral-500">{t("signIn.methodsDescription")}</p>
				</div>
				<div className="space-y-4">
					<h3 className="text-sm font-semibold text-neutral-900">{t("signIn.passwordTitle")}</h3>
					<PasswordSettings />
				</div>
				<div id="passkeys" className="scroll-mt-6 space-y-4 border-t border-neutral-100 pt-6">
					<div>
						<h3 className="text-sm font-semibold text-neutral-900">{t("passkey.settingsTitle")}</h3>
						<p className="mt-1 text-sm text-neutral-500">{t("passkey.settingsDescription")}</p>
					</div>
					<PasskeySettings />
				</div>
			</div>
			<div className="rounded-3xl bg-white p-6">
				<TwoStepSettings />
			</div>
			<div className="space-y-4 rounded-3xl bg-white p-6">
				<div>
					<h2 className="text-lg font-semibold text-neutral-900">{t("settingsPage.security.devices")}</h2>
					<p className="mt-1 text-sm text-neutral-500">{t("settingsPage.security.devicesDescription")}</p>
				</div>
				<DeviceSettings />
			</div>
		</section>
	</div>;
}
