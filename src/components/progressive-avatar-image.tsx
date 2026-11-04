"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ProgressiveAvatarImageProps } from "./progressive-avatar-image-types";
import { getAvatarPreviewUrl, rememberAvatarLoaded, wasAvatarLoaded } from "./progressive-avatar-image-utils";

export function ProgressiveAvatarImage({ src, alt, className, onError }: ProgressiveAvatarImageProps) {
	const [previewReadyFor, setPreviewReadyFor] = useState<string | null>(null);
	const [previewFailedFor, setPreviewFailedFor] = useState<string | null>(null);
	const [fullReadyFor, setFullReadyFor] = useState<string | null>(null);
	// Set after mount so server and first client render agree; the effect below then skips the preview.
	const [cachedFor, setCachedFor] = useState<string | null>(null);
	const [failedFor, setFailedFor] = useState<string | null>(null);
	const imageRef = useRef<HTMLImageElement>(null);
	const onErrorRef = useRef(onError);
	onErrorRef.current = onError;
	const showFull = previewFailedFor === src || fullReadyFor === src || cachedFor === src;

	useLayoutEffect(() => {
		if (wasAvatarLoaded(src)) setCachedFor(src);
	}, [src]);

	useEffect(() => {
		const image = imageRef.current;
		if (!image?.complete) return;
		if (image.naturalWidth > 0) setPreviewReadyFor(src);
		else setPreviewFailedFor(src);
	}, [src]);

	useEffect(() => {
		if (previewReadyFor !== src) return;
		let cancelled = false;
		const image = new Image();
		image.onload = () => {
			if (cancelled) return;
			rememberAvatarLoaded(src);
			setFullReadyFor(src);
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
	}, [previewReadyFor, src]);

	if (failedFor === src) return null;

	return (
		// eslint-disable-next-line @next/next/no-img-element
		<img
			ref={imageRef}
			src={showFull ? src : getAvatarPreviewUrl(src)}
			alt={alt}
			className={className}
			style={showFull ? undefined : { filter: "blur(4px)" }}
			onLoad={() => {
				if (!showFull) setPreviewReadyFor(src);
				else rememberAvatarLoaded(src);
			}}
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
