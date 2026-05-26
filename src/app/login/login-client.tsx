"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ArrowRight, Mail } from "lucide-react";
import { AuthShell } from "@/components/auth/auth-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { submitLogin } from "./utils";

export function LoginClient() {
	const router = useRouter();
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);

	async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
		e.preventDefault();
		setLoading(true);
		setError(null);

		const { ok, data } = await submitLogin(new FormData(e.currentTarget));
		setLoading(false);
		if (!ok) {
			setError(data.error ?? "Login failed");
			return;
		}
		router.push(data.redirect ?? "/inbox");
	}

	return (
		<AuthShell
			icon={Mail}
			title="Sign in to Mail"
			description="Open your Cloudflare-powered mailbox and continue from the same inbox workspace."
			footer={
				<Link href="/register" className="inline-flex items-center gap-2 hover:underline">
					Create account
					<ArrowRight className="h-4 w-4" />
				</Link>
			}
		>
			<form onSubmit={onSubmit} className="space-y-5">
				<div className="space-y-2">
					<Label htmlFor="email">Email</Label>
					<Input id="email" name="email" type="email" autoComplete="email" required />
				</div>
				<div className="space-y-2">
					<Label htmlFor="password">Password</Label>
					<Input id="password" name="password" type="password" autoComplete="current-password" required />
				</div>
				{error && (
					<p className="rounded-2xl border border-red-100 bg-red-50 px-4 py-3 text-sm font-medium text-red-700">
						{error}
					</p>
				)}
				<Button type="submit" className="h-11 w-full rounded-full px-6 active:scale-[0.98]" disabled={loading}>
					{loading ? "Signing in..." : "Sign in"}
				</Button>
			</form>
		</AuthShell>
	);
}
