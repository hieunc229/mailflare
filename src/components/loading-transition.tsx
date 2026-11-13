"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useIsFetching } from "@tanstack/react-query";
import { useLanguage } from "@/components/language-provider";
import { PageLoadingContext } from "@/components/page-loading";
import { RouteLoadingBar } from "@/components/route-loading-bar";
import { RouteSkeleton } from "@/components/route-skeleton";
import type { LoadingTransitionProps } from "./loading-transition-types";

const MINIMUM_LOADING_TIME = 600;
const COMPLETION_TIME = 220;
const MAXIMUM_DATA_WAIT = 10_000;
const SPLASH_ICON = "/icon-192.png";
let hasShownInitialLoadingTransition = false;

// The splash is for entering the app: the home page, sign-in, a typed URL, a bookmark or another site. A full page load
// whose referrer is another page of this app (a "View on calendar" link in an email) is not an entry.
const ENTRY_PATHS = ["/", "/login", "/setup"];

function arrivedFromInsideApp(): boolean {
	try {
		if (!document.referrer) return false;
		const referrer = new URL(document.referrer);
		return referrer.origin === window.location.origin && !ENTRY_PATHS.includes(referrer.pathname);
	} catch { return false; }
}

function splashAlreadySeen(): boolean {
	return hasShownInitialLoadingTransition || arrivedFromInsideApp();
}

// Runs while the server HTML is parsed, before first paint and before hydration, so an in-app full page load never
// flashes the splash.
const SPLASH_GUARD_SCRIPT = `try{var r=document.referrer;if(r){var u=new URL(r);if(u.origin===location.origin&&${JSON.stringify(ENTRY_PATHS)}.indexOf(u.pathname)<0)document.documentElement.setAttribute("data-splash-seen","")}}catch(e){}`;
const SPLASH_GUARD_STYLE = "html[data-splash-seen] .splash-overlay{display:none!important}";

function rememberSplashSeen() {
	hasShownInitialLoadingTransition = true;
}

export function LoadingTransition({ children, ready }: LoadingTransitionProps) {
	const { t } = useLanguage();
	// Always true on the server and first render so hydration matches; corrected before paint below.
	const [showInitialLoader, setShowInitialLoader] = useState(true);
	const [startedAt] = useState(() => Date.now());
	const [progress, setProgress] = useState(8);
	const [loaderVisible, setLoaderVisible] = useState(showInitialLoader);
	const [contentVisible, setContentVisible] = useState(!showInitialLoader);
	const [initialLoadComplete, setInitialLoadComplete] = useState(!showInitialLoader);
	const [pageMounted, setPageMounted] = useState(false);
	const [pendingLoads, setPendingLoads] = useState(0);
	const [dataWaitExpired, setDataWaitExpired] = useState(false);
	const [visibleLoads, setVisibleLoads] = useState(0);
	const loadingIds = useRef(new Set<string>());
	const visibleIds = useRef(new Set<string>());
	const fetchingQueries = useIsFetching();

	const reportLoading = useCallback((id: string, loading: boolean, silent = false) => {
		if (loading) loadingIds.current.add(id);
		else loadingIds.current.delete(id);
		if (loading && !silent) visibleIds.current.add(id);
		else visibleIds.current.delete(id);
		setPendingLoads(loadingIds.current.size);
		setVisibleLoads(visibleIds.current.size);
	}, []);
	const loadingContext = useMemo(() => ({ reportLoading }), [reportLoading]);
	useLayoutEffect(() => {
		if (!splashAlreadySeen()) return;
		// eslint-disable-next-line react-hooks/set-state-in-effect -- sessionStorage is only readable on the client, and this must apply before first paint
		setShowInitialLoader(false);
		setLoaderVisible(false);
		setContentVisible(true);
		setInitialLoadComplete(true);
	}, []);
	const canComplete = ready && pageMounted && (dataWaitExpired || (pendingLoads === 0 && fetchingQueries === 0));

	useEffect(() => {
		if (canComplete) return;
		const timer = window.setInterval(() => {
			setProgress((current) => Math.min(92, current + Math.max(1, (92 - current) * 0.08)));
		}, 90);
		return () => window.clearInterval(timer);
	}, [canComplete]);

	useEffect(() => {
		if (!ready) return;
		const timer = window.setTimeout(() => setPageMounted(true), 50);
		return () => window.clearTimeout(timer);
	}, [ready]);

	useEffect(() => {
		if (!ready) return;
		const timer = window.setTimeout(() => setDataWaitExpired(true), MAXIMUM_DATA_WAIT);
		return () => window.clearTimeout(timer);
	}, [ready]);

	useEffect(() => {
		if (!canComplete) return;
		const remaining = showInitialLoader
			? Math.max(0, MINIMUM_LOADING_TIME - (Date.now() - startedAt))
			: 0;
		const completeTimer = window.setTimeout(() => setProgress(100), remaining);
		const revealTimer = window.setTimeout(() => {
			if (showInitialLoader) {
				rememberSplashSeen();
				setLoaderVisible(false);
				setContentVisible(true);
			}
			setInitialLoadComplete(true);
		}, remaining + COMPLETION_TIME);
		return () => {
			window.clearTimeout(completeTimer);
			window.clearTimeout(revealTimer);
		};
	}, [canComplete, showInitialLoader, startedAt]);

	const showTopLoadingBar = initialLoadComplete && (!ready || visibleLoads > 0);

	return (
		<PageLoadingContext.Provider value={loadingContext}>
			<div className="relative min-h-dvh bg-[#f6f8fc]">
				<style dangerouslySetInnerHTML={{ __html: SPLASH_GUARD_STYLE }} />
				<script dangerouslySetInnerHTML={{ __html: SPLASH_GUARD_SCRIPT }} suppressHydrationWarning />
				{showTopLoadingBar && <RouteLoadingBar />}
				{!ready && !showInitialLoader && <div aria-hidden="true"><RouteSkeleton /></div>}
				{ready && (
					<div
						className={`min-h-dvh transition-opacity duration-300 ${contentVisible ? "opacity-100" : "opacity-0"}`}
					>
						{children}
					</div>
				)}
				<div
					role="status"
					className={`splash-overlay fixed inset-0 z-[100] flex items-center justify-center bg-[#f6f8fc] transition-opacity duration-300 ${
						loaderVisible ? "opacity-100" : "pointer-events-none opacity-0"
					}`}
				>
					<span className="sr-only">{loaderVisible ? t("nav.loading") : ""}</span>
					<div aria-hidden="true" className="flex w-64 flex-col items-center gap-6">
						<img
							src={SPLASH_ICON}
							alt=""
							className="h-20 w-20 rounded-2xl object-contain"
						/>
						<div className="w-full">
							<div className="h-1.5 overflow-hidden rounded-full bg-blue-100">
								<div
									className="h-full rounded-full bg-blue-600 transition-[width] duration-200 ease-out"
									style={{ width: `${progress}%` }}
								/>
							</div>
						</div>
					</div>
				</div>
			</div>
		</PageLoadingContext.Provider>
	);
}
