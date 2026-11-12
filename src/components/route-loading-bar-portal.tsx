"use client";

import { useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { RouteLoadingBar } from "./route-loading-bar";

const subscribeNothing = () => () => {};
const mountedOnClient = () => true;
const mountedOnServer = () => false;

// Pinned to the viewport top even when an ancestor's transform (e.g. a page transition) would otherwise become the fixed containing block.
export function RouteLoadingBarPortal() {
	const mounted = useSyncExternalStore(subscribeNothing, mountedOnClient, mountedOnServer);
	if (!mounted) return <RouteLoadingBar />;
	return createPortal(<RouteLoadingBar />, document.body);
}
