"use client";

import Link from "next/link";
import { LogIn, UserPlus } from "lucide-react";
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
				<Button key={action.href} variant={action.variant} asChild className="h-10 w-10 px-0 sm:w-auto sm:px-6">
					<Link href={action.href} aria-label={t(action.labelKey)}>
						{action.href === "/login" ? <LogIn className="h-4 w-4 sm:hidden" aria-hidden="true" /> : <UserPlus className="h-4 w-4 sm:hidden" aria-hidden="true" />}
						<span className="hidden sm:inline">{t(action.labelKey)}</span>
					</Link>
				</Button>
			))}
		</>
	);
}
