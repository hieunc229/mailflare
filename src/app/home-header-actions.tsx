"use client";

import Link from "next/link";
import { useLanguage } from "@/components/language-provider";
import { Button } from "@/components/ui/button";
import { getHomeActions } from "./utils";
import { HomeAccountMenu } from "./home-account-menu";
import { useHomeAuth } from "./home-auth";

export function HomeHeaderActions() {
	const { t } = useLanguage();
	const user = useHomeAuth();
	if (user) return <HomeAccountMenu user={user} />;

	return (
		<>
			{getHomeActions(false).map((action) => (
				<Button key={action.href} variant={action.variant} asChild>
					<Link href={action.href}>{t(action.labelKey)}</Link>
				</Button>
			))}
		</>
	);
}
