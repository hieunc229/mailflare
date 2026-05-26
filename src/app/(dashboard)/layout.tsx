import Link from "next/link";
import { redirect } from "next/navigation";
import { HelpCircle, Search } from "lucide-react";

export const dynamic = "force-dynamic";
import { ComposeProvider } from "@/components/compose/compose-context";
import { FloatingComposer } from "@/components/compose/floating-composer";
import { DashboardShellNav } from "@/components/dashboard-shell";
import { MailboxProvider } from "@/components/mailbox-provider";
import { MailboxSelector } from "@/components/mailbox-selector";
import { getEnv } from "@/lib/cloudflare";
import { getCurrentUser } from "@/lib/auth/cookies";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
	const env = getEnv();
	const user = await getCurrentUser(env);
	if (!user) redirect("/login");

	return (
		<MailboxProvider>
			<ComposeProvider>
				<div className="grid min-h-screen grid-cols-[256px_1fr] bg-[#f6f8fc]">
					<aside className="flex flex-col gap-4 px-3 py-4">
						<DashboardShellNav />
					</aside>
					<div className="flex min-h-screen flex-col">
						<header className="flex h-16 items-center gap-4 pr-4 text-sm">
							<div className="flex h-12 flex-1 max-w-3xl items-center gap-3 rounded-full bg-[#eaf1fb] px-4 text-neutral-600">
								<Search className="h-5 w-5" />
								<span className="text-[15px]">Search mail</span>
							</div>
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
			</ComposeProvider>
		</MailboxProvider>
	);
}
