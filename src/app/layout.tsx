import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Providers } from "@/components/providers";
import "./globals.css";

const geistSans = Geist({
	variable: "--font-geist-sans",
	subsets: ["latin"],
});

const geistMono = Geist_Mono({
	variable: "--font-geist-mono",
	subsets: ["latin"],
});

export const metadata: Metadata = {
	title: "Mailflare",
	description: "Multi-tenant email on Cloudflare",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
	return (
		<html lang="en">
			<head>
				<link rel="icon" type="image/x-icon" href="/favicon.ico"></link>
			</head>
			<body className={`${geistSans.variable} ${geistMono.variable} antialiased light`}>
				<Providers>{children}</Providers>
			</body>
		</html>
	);
}
