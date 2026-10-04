"use client";

import { useEffect, useRef, useState } from "react";
import type { ClipboardEvent, KeyboardEvent } from "react";
import {
	Bold,
	Italic,
	Link2,
	List,
	ListOrdered,
	PilcrowLeft,
	PilcrowRight,
	Quote,
	RemoveFormatting,
	Strikethrough,
	Underline,
} from "lucide-react";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { RichTextEditorProps, TextDirection, ToolbarCommand } from "./rich-text-editor-types";
import { DIRECTION_BLOCK_SELECTOR, SIGNATURE_ATTRIBUTE, listDirection } from "./rich-text-utils";

const COMMANDS: ToolbarCommand[] = [
	{ command: "bold", label: "Bold (⌘B)", icon: Bold },
	{ command: "italic", label: "Italic (⌘I)", icon: Italic },
	{ command: "underline", label: "Underline (⌘U)", icon: Underline },
	{ command: "strikeThrough", label: "Strikethrough", icon: Strikethrough },
	{ command: "insertUnorderedList", label: "Bulleted list", icon: List },
	{ command: "insertOrderedList", label: "Numbered list", icon: ListOrdered },
	{ command: "formatBlock", label: "Quote", icon: Quote, value: "blockquote" },
];

const DIRECTIONS: { direction: TextDirection; label: string; icon: ToolbarCommand["icon"] }[] = [
	{ direction: "ltr", label: "Left-to-right text", icon: PilcrowRight },
	{ direction: "rtl", label: "Right-to-left text", icon: PilcrowLeft },
];

function closestBlock(node: Node | null, root: HTMLElement): HTMLElement | null {
	let current = node && node.nodeType === Node.ELEMENT_NODE ? (node as HTMLElement) : node?.parentElement ?? null;
	while (current && current !== root && root.contains(current)) {
		if (current.matches(DIRECTION_BLOCK_SELECTOR)) return current;
		current = current.parentElement;
	}
	return null;
}

/** The innermost blocks the selection touches, or null while it sits in loose text that has no block yet. */
function selectedBlocks(root: HTMLElement): HTMLElement[] | null {
	const selection = window.getSelection();
	if (!selection || selection.rangeCount === 0) return [];
	const range = selection.getRangeAt(0);
	if (!root.contains(range.commonAncestorContainer)) return [];
	const start = closestBlock(range.startContainer, root);
	const end = closestBlock(range.endContainer, root);
	if (!start || !end) return null;
	const blocks = new Set([start, end]);
	for (const block of Array.from(root.querySelectorAll<HTMLElement>(DIRECTION_BLOCK_SELECTOR))) {
		if (range.intersectsNode(block) && !block.querySelector(DIRECTION_BLOCK_SELECTOR)) blocks.add(block);
	}
	return Array.from(blocks);
}

/**
 * Paragraphs without a chosen direction follow their own first strong
 * character, and lists follow their first item so the indent sits on the
 * bullets' side. The signature keeps its markup untouched so it can be swapped.
 */
function markAutoDirection(root: HTMLElement): void {
	for (const block of Array.from(root.querySelectorAll<HTMLElement>(DIRECTION_BLOCK_SELECTOR))) {
		if (block.closest(`[${SIGNATURE_ATTRIBUTE}]`)) continue;
		if (block.tagName === "UL" || block.tagName === "OL") {
			block.setAttribute("dir", listDirection(block) === "rtl" ? "rtl" : "auto");
			continue;
		}
		if (block.hasAttribute("dir")) continue;
		const chosen = block.parentElement?.closest("[dir]:not(ul, ol)");
		if (chosen && chosen !== root && root.contains(chosen) && chosen.getAttribute("dir") !== "auto") continue;
		block.setAttribute("dir", "auto");
	}
}

function chosenDirection(root: HTMLElement): TextDirection | null {
	const block = closestBlock(window.getSelection()?.anchorNode ?? null, root);
	const value = block?.closest("[dir]");
	if (!value || !root.contains(value)) return null;
	const direction = value.getAttribute("dir");
	return direction === "rtl" || direction === "ltr" ? direction : null;
}

/**
 * A small HTML editor built on contentEditable. It stays deliberately light:
 * inline styles, lists, quotes and links, with pasted content flattened to
 * text so a message never carries another site's markup.
 */
export function RichTextEditor({
	id,
	value,
	onChange,
	quotedHtml,
	disabled,
	placeholder,
	className,
	toolbarStart,
	toolbarEnd,
	footerContent,
}: RichTextEditorProps) {
	const editorRef = useRef<HTMLDivElement | null>(null);
	const [active, setActive] = useState<Record<string, boolean>>({});
	const [direction, setDirection] = useState<TextDirection | null>(null);
	const [linkOpen, setLinkOpen] = useState(false);
	const [linkUrl, setLinkUrl] = useState("");
	const [showQuoted, setShowQuoted] = useState(false);
	const savedRange = useRef<Range | null>(null);

	// Keep the DOM in step with the value without resetting the caret on every keystroke.
	useEffect(() => {
		const element = editorRef.current;
		if (element && element.innerHTML !== value) {
			element.innerHTML = value;
			markAutoDirection(element);
		}
	}, [value]);

	useEffect(() => {
		function refresh() {
			const element = editorRef.current;
			if (!element || !element.contains(document.activeElement)) return;
			const next: Record<string, boolean> = {};
			for (const item of COMMANDS) {
				if (item.command === "formatBlock") {
					next[item.command] = document.queryCommandValue("formatBlock").toLowerCase() === "blockquote";
				} else {
					next[item.command] = document.queryCommandState(item.command);
				}
			}
			setActive(next);
			setDirection(chosenDirection(element));
		}
		document.addEventListener("selectionchange", refresh);
		return () => document.removeEventListener("selectionchange", refresh);
	}, []);

	function emit() {
		const element = editorRef.current;
		if (element) markAutoDirection(element);
		onChange(element?.innerHTML ?? "");
	}

	function run(command: string, commandValue?: string) {
		editorRef.current?.focus();
		if (command === "formatBlock" && active.formatBlock) {
			document.execCommand("formatBlock", false, "div");
		} else {
			document.execCommand(command, false, commandValue);
		}
		emit();
	}

	/**
	 * Paragraphs follow their own first strong character until the writer picks
	 * a direction here; picking the current one again returns them to automatic.
	 */
	function applyDirection(next: TextDirection) {
		const element = editorRef.current;
		if (!element) return;
		element.focus();
		let blocks = selectedBlocks(element);
		if (blocks === null) {
			document.execCommand("formatBlock", false, "div");
			blocks = selectedBlocks(element);
		}
		if (!blocks?.length) return;
		const reset = blocks.every((block) => block.getAttribute("dir") === next);
		for (const block of blocks) block.setAttribute("dir", reset ? "auto" : next);
		setDirection(chosenDirection(element));
		emit();
	}

	function openLink() {
		const selection = window.getSelection();
		savedRange.current = selection && selection.rangeCount > 0 ? selection.getRangeAt(0).cloneRange() : null;
		setLinkUrl("");
		setLinkOpen(true);
	}

	function applyLink() {
		const url = linkUrl.trim();
		setLinkOpen(false);
		if (!url) return;
		const href = /^(https?:|mailto:)/i.test(url) ? url : `https://${url}`;
		editorRef.current?.focus();
		const selection = window.getSelection();
		if (savedRange.current && selection) {
			selection.removeAllRanges();
			selection.addRange(savedRange.current);
		}
		if (selection && selection.isCollapsed) {
			document.execCommand("insertHTML", false, `<a href="${href.replace(/"/g, "&quot;")}">${href}</a>`);
		} else {
			document.execCommand("createLink", false, href);
		}
		emit();
	}

	function onPaste(event: ClipboardEvent<HTMLDivElement>) {
		event.preventDefault();
		const text = event.clipboardData.getData("text/plain");
		document.execCommand("insertText", false, text);
	}

	function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
		if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
			event.preventDefault();
			openLink();
		}
	}

	return (
		<div className={cn("flex min-h-0 flex-1 flex-col", className)}>
			<div className="relative min-h-0 flex-1 overflow-y-auto">
				<div
					ref={editorRef}
					id={id}
					dir="auto"
					role="textbox"
					aria-multiline="true"
					aria-label="Message body"
					contentEditable={!disabled}
					suppressContentEditableWarning
					data-placeholder={placeholder}
					onInput={emit}
					onBlur={emit}
					onPaste={onPaste}
					onKeyDown={onKeyDown}
					className={cn(
						"email-body max-w-none px-4 py-3 text-sm text-neutral-900 outline-none",
						"min-h-32 empty:before:pointer-events-none empty:before:text-neutral-400 empty:before:content-[attr(data-placeholder)]",
						disabled && "cursor-not-allowed opacity-60",
					)}
				/>
				{quotedHtml && (
					<div className="px-4 pb-3">
						<button
							type="button"
							onClick={() => setShowQuoted((open) => !open)}
							aria-expanded={showQuoted}
							className="rounded-full border border-neutral-200 bg-neutral-100 px-2 text-xs leading-5 text-neutral-500 hover:bg-neutral-200"
							title={showQuoted ? "Hide quoted text" : "Show quoted text"}
						>
							•••
						</button>
						{showQuoted && (
							<div
								dir="auto"
								className="email-body mt-2 max-w-none border-s-2 border-neutral-200 ps-3 text-sm text-neutral-600"
								dangerouslySetInnerHTML={{ __html: quotedHtml }}
							/>
						)}
					</div>
				)}
			</div>
			{footerContent}
			<div className="relative flex items-center gap-0.5 border-t border-neutral-100 px-4 py-3">
				{toolbarStart}
				{COMMANDS.map((item) => (
					<Tooltip key={item.command} label={item.label}>
						<button
							type="button"
							aria-label={item.label}
							aria-pressed={!!active[item.command]}
							disabled={disabled}
							onMouseDown={(event) => event.preventDefault()}
							onClick={() => run(item.command, item.value)}
							className={cn(
								"rounded-md p-1.5 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900",
								active[item.command] && "bg-neutral-200 text-neutral-900",
							)}
						>
							<item.icon className="h-4 w-4" />
						</button>
					</Tooltip>
				))}
				{DIRECTIONS.map((item) => (
					<Tooltip key={item.direction} label={item.label}>
						<button
							type="button"
							aria-label={item.label}
							aria-pressed={direction === item.direction}
							disabled={disabled}
							onMouseDown={(event) => event.preventDefault()}
							onClick={() => applyDirection(item.direction)}
							className={cn(
								"rounded-md p-1.5 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900",
								direction === item.direction && "bg-neutral-200 text-neutral-900",
							)}
						>
							<item.icon className="h-4 w-4" />
						</button>
					</Tooltip>
				))}
				<Tooltip label="Insert link (⌘K)">
					<button
						type="button"
						aria-label="Insert link"
						disabled={disabled}
						onMouseDown={(event) => event.preventDefault()}
						onClick={openLink}
						className="rounded-md p-1.5 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900"
					>
						<Link2 className="h-4 w-4" />
					</button>
				</Tooltip>
				<Tooltip label="Clear formatting">
					<button
						type="button"
						aria-label="Clear formatting"
						disabled={disabled}
						onMouseDown={(event) => event.preventDefault()}
						onClick={() => run("removeFormat")}
						className="rounded-md p-1.5 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900"
					>
						<RemoveFormatting className="h-4 w-4" />
					</button>
				</Tooltip>
				{toolbarEnd}
				{linkOpen && (
					<form
						className="absolute bottom-full left-2 z-10 mb-1 flex items-center gap-2 rounded-lg border border-neutral-200 bg-white p-2 shadow-lg"
						onSubmit={(event) => {
							event.preventDefault();
							applyLink();
						}}
					>
						<input
							autoFocus
							value={linkUrl}
							onChange={(event) => setLinkUrl(event.target.value)}
							onKeyDown={(event) => {
								if (event.key === "Escape") setLinkOpen(false);
							}}
							placeholder="https://example.com"
							className="h-8 w-64 rounded-md border border-neutral-200 px-2 text-sm outline-none focus:border-blue-400"
						/>
						<button type="submit" className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700">
							Apply
						</button>
					</form>
				)}
			</div>
		</div>
	);
}
