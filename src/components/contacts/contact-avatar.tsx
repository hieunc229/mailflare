"use client";

import { useEffect, useState } from "react";
import { ProgressiveAvatarImage } from "@/components/progressive-avatar-image";
import { CONTACT_AVATAR_CHANGED_EVENT } from "@/lib/contacts/avatar-client";
import { normalizeEmailAddress } from "@/lib/email/address";
import { getAvatarColorStyle } from "@/lib/avatar-colors";
import { cn } from "@/lib/utils";
import type { ContactAvatarProps } from "./contact-avatar-types";
import {
	getContactAvatarInitial,
	getManagedContactAvatarUrl,
} from "./contact-avatar-utils";

export function ContactAvatar({
	mailboxId,
	address,
	name,
	hasManagedAvatar = false,
	managedAvatarUrl,
	className,
}: ContactAvatarProps) {
	const [managedAvatar, setManagedAvatar] = useState(hasManagedAvatar);
	const [imageFailed, setImageFailed] = useState(false);
	const [avatarVersion, setAvatarVersion] = useState(0);

	// A different contact starts over from its props.
	const [prevContact, setPrevContact] = useState({ address, hasManagedAvatar, mailboxId, managedAvatarUrl });
	if (address !== prevContact.address || hasManagedAvatar !== prevContact.hasManagedAvatar || mailboxId !== prevContact.mailboxId || managedAvatarUrl !== prevContact.managedAvatarUrl) {
		setPrevContact({ address, hasManagedAvatar, mailboxId, managedAvatarUrl });
		setManagedAvatar(hasManagedAvatar);
		setImageFailed(false);
		setAvatarVersion(0);
	}
	// A new image source gets a fresh chance to load.
	const [prevSource, setPrevSource] = useState({ managedAvatar, avatarVersion });
	if (managedAvatar !== prevSource.managedAvatar || avatarVersion !== prevSource.avatarVersion) {
		setPrevSource({ managedAvatar, avatarVersion });
		setImageFailed(false);
	}
	const avatarUrl = managedAvatarUrl
		? managedAvatarUrl
		: managedAvatar && mailboxId
			? getManagedContactAvatarUrl(mailboxId, address, avatarVersion)
			: null;

	useEffect(() => {
		function onAvatarChanged(event: Event) {
			const detail = (event as CustomEvent<{ email?: string; hasAvatar?: boolean }>).detail;
			if (detail?.email === normalizeEmailAddress(address)) {
				setManagedAvatar(!!detail.hasAvatar);
				setAvatarVersion(Date.now());
			}
		}

		window.addEventListener(CONTACT_AVATAR_CHANGED_EVENT, onAvatarChanged);
		return () => window.removeEventListener(CONTACT_AVATAR_CHANGED_EVENT, onAvatarChanged);
	}, [address]);

	return (
		<span
			className={cn("relative flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-full bg-neutral-200 text-sm font-semibold text-neutral-700", className)}
			style={getAvatarColorStyle(normalizeEmailAddress(address) || name)}
			aria-hidden
		>
			{getContactAvatarInitial(name, address)}
			{avatarUrl && !imageFailed && (
				<ProgressiveAvatarImage
					src={avatarUrl}
					alt=""
					className="absolute inset-0 h-full w-full object-cover"
					onError={() => {
						if (managedAvatarUrl) setImageFailed(true);
						else if (managedAvatar) setManagedAvatar(false);
						else setImageFailed(true);
					}}
				/>
			)}
		</span>
	);
}
