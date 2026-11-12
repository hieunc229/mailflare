export type ProgressiveAvatarImageProps = {
	src: string;
	alt: string;
	className?: string;
	onError?: () => void;
	/** Load the full image directly; the blurred preview is not worth a second request for small avatars. */
	skipPreview?: boolean;
};
