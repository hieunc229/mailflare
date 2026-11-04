import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Providers } from "@/components/providers";
import { LanguageProvider } from "@/components/language-provider";
import { DEFAULT_LOCALE, getDirection } from "@/lib/i18n/utils";
import { getRequestLocale, loadServerMessages } from "@/lib/i18n/server";
import { sidebarBootstrapScript } from "@/components/sidebar-state-utils";
import { themeBootstrapScript } from "@/components/theme-utils";
import { getHomeBranding } from "./home-server-utils";
import "./globals.css";

const geistSans = Geist({
	variable: "--font-geist-sans",
	subsets: ["latin"],
});

const geistMono = Geist_Mono({
	variable: "--font-geist-mono",
	subsets: ["latin"],
});

export async function generateMetadata(): Promise<Metadata> {
	const { appName } = await getHomeBranding();
	return {
		title: appName,
		description: "Multi-tenant email on Cloudflare",
		icons: { icon: "/api/branding/icon", apple: "/icon-192.png" },
		appleWebApp: {
			capable: true,
			title: appName,
			statusBarStyle: "default",
		},
		robots: {
			index: false,
			follow: false,
			noarchive: true,
			nosnippet: true,
			noimageindex: true,
			googleBot: {
				index: false,
				follow: false,
				noarchive: true,
				nosnippet: true,
				noimageindex: true,
			},
		},
	};
}

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
	const locale = await getRequestLocale();
	const messages = locale === DEFAULT_LOCALE ? undefined : await loadServerMessages(locale);
	const branding = await getHomeBranding();
	return (
		<html lang={locale} dir={getDirection(locale)} data-remote-image-proxy="enabled" suppressHydrationWarning>
			<head>
				<script dangerouslySetInnerHTML={{ __html: sidebarBootstrapScript }} />
				<script dangerouslySetInnerHTML={{ __html: themeBootstrapScript }} />
				<link rel="icon" href="/api/branding/icon"></link>
			</head>
			<body className={`${geistSans.variable} ${geistMono.variable} antialiased`}>
				<LanguageProvider initialLocale={locale} initialMessages={messages}><Providers initialBranding={branding}>{children}</Providers></LanguageProvider>
			</body>
		</html>
	);
}
