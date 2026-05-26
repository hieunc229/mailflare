import { Inbox, MailCheck, Search, ShieldCheck } from "lucide-react";
import type { AuthShellProps } from "./types";

export function AuthShell({ icon: Icon, title, description, children, footer, steps }: AuthShellProps) {
	return (
		<div className="min-h-[100dvh] bg-[#f6f8fc] p-4 text-neutral-900 sm:p-6">
			<div className="mx-auto flex min-h-[calc(100dvh-32px)] max-w-6xl items-center sm:min-h-[calc(100dvh-48px)]">
				<div className="grid w-full overflow-hidden rounded-[2rem] border border-white bg-white shadow-[0_24px_70px_-45px_rgba(30,64,175,0.55)] lg:grid-cols-[1.05fr_440px]">
					<section className="relative hidden min-h-[620px] overflow-hidden bg-[#f6f8fc] p-5 lg:block">
						<div className="grid h-full grid-cols-[168px_1fr] overflow-hidden rounded-[1.5rem] border border-neutral-100 bg-white">
							<aside className="flex flex-col gap-2 bg-[#f6f8fc] px-3 py-5">
								<div className="mb-4 flex items-center gap-3 px-3 text-neutral-700">
									<Inbox className="h-5 w-5" />
									<span className="font-semibold">Mail</span>
								</div>
								<div className="mb-3 flex h-12 w-fit items-center gap-2 rounded-2xl bg-blue-100 px-5 text-sm font-semibold text-blue-950 shadow-sm">
									<Icon className="h-4 w-4" />
									Compose
								</div>
								{["Inbox", "Sent", "Drafts", "Settings"].map((item, index) => (
									<div
										key={item}
										className={`flex h-9 items-center rounded-r-full px-3 text-sm font-medium ${
											index === 0 ? "bg-blue-100 text-blue-950" : "text-neutral-600"
										}`}
									>
										{item}
									</div>
								))}
							</aside>

							<div className="flex min-w-0 flex-col">
								<div className="flex h-16 items-center gap-3 bg-[#f6f8fc] px-4">
									<div className="flex h-12 flex-1 items-center gap-3 rounded-full bg-[#eaf1fb] px-4 text-neutral-600">
										<Search className="h-5 w-5" />
										<span className="text-[15px]">Search mail</span>
									</div>
								</div>
								<div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-tl-3xl bg-white">
									<div className="flex h-14 items-center justify-between border-b border-neutral-200 px-6">
										<div className="flex items-center gap-3">
											<h2 className="text-xl font-medium text-neutral-800">Inbox</h2>
											<span className="rounded-full bg-neutral-100 px-2.5 py-1 text-xs font-medium text-neutral-600">
												4
											</span>
										</div>
										<MailCheck className="h-4 w-4 text-neutral-400" />
									</div>
									<div className="divide-y divide-neutral-100">
										{[
											["Route monitor", "DNS records verified", "Ready"],
											["API delivery", "Message accepted by worker", "Sent"],
											["Mailbox setup", "First address is active", "New"],
											["Security", "Session protected", "OK"],
										].map(([sender, subject, badge]) => (
											<div
												key={sender}
												className="grid min-h-14 grid-cols-[minmax(110px,170px)_1fr_auto] items-center gap-3 px-5 text-sm hover:bg-[#f2f6fc]"
											>
												<span className="truncate font-semibold text-neutral-900">{sender}</span>
												<span className="truncate font-medium text-neutral-700">{subject}</span>
												<span className="rounded-full bg-blue-50 px-2.5 py-1 text-xs font-semibold text-blue-700">
													{badge}
												</span>
											</div>
										))}
									</div>
								</div>
							</div>
						</div>
					</section>

					<section className="flex min-h-[620px] flex-col justify-between p-6 sm:p-10">
						<div>
							<div className="mb-8 flex h-12 w-12 items-center justify-center rounded-2xl bg-blue-100 text-blue-700">
								<Icon className="h-6 w-6" />
							</div>
							<div className="mb-8">
								<div className="mb-3 flex items-center gap-2 text-sm font-semibold text-blue-700">
									<ShieldCheck className="h-4 w-4" />
									Cloudflare mail workspace
								</div>
								<h1 className="max-w-sm text-4xl font-semibold leading-tight tracking-tight text-neutral-950">
									{title}
								</h1>
								<p className="mt-4 max-w-md text-sm leading-6 text-neutral-600">{description}</p>
							</div>
							{steps && (
								<div className="mb-8 flex gap-2 text-xs font-semibold">
									{steps.map((step, index) => (
										<span key={step.label} className="flex items-center gap-2">
											<span className={step.active ? "text-blue-700" : "text-neutral-400"}>
												{index + 1} {step.label}
											</span>
											{index < steps.length - 1 && <span className="text-neutral-300">/</span>}
										</span>
									))}
								</div>
							)}
							{children}
						</div>
						<div className="mt-8 text-sm font-medium text-blue-700">{footer}</div>
					</section>
				</div>
			</div>
		</div>
	);
}
