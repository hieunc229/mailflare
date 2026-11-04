"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useIsFetching } from "@tanstack/react-query";
import { useBranding } from "@/components/branding-provider";
import { useLanguage } from "@/components/language-provider";
import { PageLoadingContext } from "@/components/page-loading";
import { RouteLoadingBar } from "@/components/route-loading-bar";
import type { LoadingTransitionProps } from "./loading-transition-types";

const MINIMUM_LOADING_TIME = 600;
const COMPLETION_TIME = 220;
const MAXIMUM_DATA_WAIT = 10_000;
let hasShownInitialLoadingTransition = false;

export function LoadingTransition({ children, ready }: LoadingTransitionProps) {
	const { t } = useLanguage();
	const branding = useBranding();
	const showInitialLoader = useRef(!hasShownInitialLoadingTransition).current;
	const startedAt = useRef(Date.now());
	const [progress, setProgress] = useState(8);
	const [loaderVisible, setLoaderVisible] = useState(showInitialLoader);
	const [contentVisible, setContentVisible] = useState(!showInitialLoader);
	const [initialLoadComplete, setInitialLoadComplete] = useState(!showInitialLoader);
	const [iconUrl, setIconUrl] = useState(branding.iconUrl);
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
	const canComplete = ready && pageMounted && (dataWaitExpired || (pendingLoads === 0 && fetchingQueries === 0));

	useEffect(() => {
		setIconUrl(branding.iconUrl);
	}, [branding.iconUrl]);

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
			? Math.max(0, MINIMUM_LOADING_TIME - (Date.now() - startedAt.current))
			: 0;
		const completeTimer = window.setTimeout(() => setProgress(100), remaining);
		const revealTimer = window.setTimeout(() => {
			if (showInitialLoader) {
				hasShownInitialLoadingTransition = true;
				setLoaderVisible(false);
				setContentVisible(true);
			}
			setInitialLoadComplete(true);
		}, remaining + COMPLETION_TIME);
		return () => {
			window.clearTimeout(completeTimer);
			window.clearTimeout(revealTimer);
		};
	}, [canComplete, showInitialLoader]);

	const showTopLoadingBar = initialLoadComplete && (!ready || visibleLoads > 0);

	return (
		<PageLoadingContext.Provider value={loadingContext}>
			<div className="relative min-h-dvh bg-[#f6f8fc]">
				{showTopLoadingBar && <RouteLoadingBar />}
				{ready && (
					<div
						className={`min-h-dvh transition-opacity duration-300 ${contentVisible ? "opacity-100" : "opacity-0"}`}
					>
						{children}
					</div>
				)}
				<div
					role="status"
					className={`fixed inset-0 z-[100] flex items-center justify-center bg-[#f6f8fc] transition-opacity duration-300 ${
						loaderVisible ? "opacity-100" : "pointer-events-none opacity-0"
					}`}
				>
					<span className="sr-only">{loaderVisible ? t("nav.loading") : ""}</span>
					<div aria-hidden="true" className="flex w-64 flex-col items-center gap-6">
						<img
							src={iconUrl}
							onError={() => setIconUrl("/icon-192.png")}
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
