import Link from "next/link";
import { redirect } from "next/navigation";
import { HelpCircle } from "lucide-react";

export const dynamic = "force-dynamic";
import { ComposeProvider } from "@/components/compose/compose-context";
import { FloatingComposer } from "@/components/compose/floating-composer";
import { MailSearchInput } from "@/components/mail-search/mail-search-input";
import { MailSearchProvider } from "@/components/mail-search/mail-search-context";
import { MailboxProvider } from "@/components/mailbox-provider";
import { MailboxSelector } from "@/components/mailbox-selector";
import { getEnv } from "@/lib/cloudflare";
import { getCurrentUser } from "@/lib/auth/cookies";
import { DashboardNav } from "@/components/dashboard-nav";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
	const env = getEnv();
	const user = await getCurrentUser(env);
	if (!user) redirect("/login");

	return (
		<MailboxProvider>
			<ComposeProvider>
				<MailSearchProvider>
					<div className="grid min-h-screen grid-cols-[256px_1fr] bg-[#f6f8fc]">
						<aside className="flex flex-col gap-4 px-3 py-4">
							<DashboardNav />
						</aside>
						<div className="flex min-h-screen flex-col">
							<header className="flex h-16 items-center gap-4 pr-4 text-sm">
								<MailSearchInput />
								<Link
									href="/settings"
									className="flex h-10 w-10 items-center justify-center rounded-full text-neutral-600 hover:bg-neutral-200"
								>
									<HelpCircle className="h-5 w-5" />
								</Link>
								<MailboxSelector />
							</header>
							<main className="flex-1 overflow-hidden rounded-tl-3xl bg-white">{children}</main>
						</div>
						<FloatingComposer />
					</div>
				</MailSearchProvider>
			</ComposeProvider>
		</MailboxProvider>
	);
}
