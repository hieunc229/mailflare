"use client";

import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

export function LogoutButton() {
	const router = useRouter();
	return (
		<Button
			variant="outline"
			className="w-full"
			onClick={async () => {
				await fetch("/api/auth/logout", { method: "POST" });
				router.push("/login");
			}}
		>
			Log out
		</Button>
	);
}
