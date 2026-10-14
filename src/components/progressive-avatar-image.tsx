"use client";

import { useEffect, useRef, useState } from "react";
import type { ProgressiveAvatarImageProps } from "./progressive-avatar-image-types";
import { getAvatarPreviewUrl } from "./progressive-avatar-image-utils";

const readyUrls = new Set<string>();
const MAX_READY_URLS = 200;

function rememberReady(src: string) {
	readyUrls.delete(src);
	readyUrls.add(src);
	if (readyUrls.size > MAX_READY_URLS) readyUrls.delete(readyUrls.values().next().value!);
}

export function ProgressiveAvatarImage({ src, alt, className, onError }: ProgressiveAvatarImageProps) {
	const [previewFailedFor, setPreviewFailedFor] = useState<string | null>(null);
	const [fullReadyFor, setFullReadyFor] = useState<string | null>(null);
	const [failedFor, setFailedFor] = useState<string | null>(null);
	const onErrorRef = useRef(onError);
	const showFull = previewFailedFor === src || fullReadyFor === src || readyUrls.has(src);
	useEffect(() => { onErrorRef.current = onError; }, [onError]);

	useEffect(() => {
		if (readyUrls.has(src)) return;
		let cancelled = false;
		const image = new Image();
		image.onload = () => {
			if (!cancelled) {
				rememberReady(src);
				setFullReadyFor(src);
			}
		};
		image.onerror = () => {
			if (!cancelled) {
				setFailedFor(src);
				onErrorRef.current?.();
			}
		};
		image.src = src;
		return () => {
			cancelled = true;
			image.onload = null;
			image.onerror = null;
		};
	}, [src]);

	if (failedFor === src) return null;

	return (
		// eslint-disable-next-line @next/next/no-img-element
		<img
			src={showFull ? src : getAvatarPreviewUrl(src)}
			alt={alt}
			className={className}
			style={showFull ? undefined : { filter: "blur(4px)" }}
			onError={() => {
				if (showFull) {
					setFailedFor(src);
					onErrorRef.current?.();
				} else {
					setPreviewFailedFor(src);
				}
			}}
		/>
	);
}
