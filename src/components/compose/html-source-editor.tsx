import { useDeferredValue, useMemo, useRef } from "react";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/utils";

const CODE_LAYOUT = "whitespace-pre py-3 font-mono! text-sm leading-6 tracking-normal [font-variant-ligatures:none] [tab-size:4]";
const TAG = "text-[#00c9ff]";
const ATTRIBUTE = "text-[#ffdc00]";
const VALUE = "text-[#23efbd]";
const COMMENT = "text-[#a1a8b3]";
const ENTITY = "text-[#ffdc00]";
// Keep large pasted templates editable without building thousands of highlight nodes.
const MAX_HIGHLIGHT_LENGTH = 65_536;

function highlightHtml(source: string): ReactNode[] {
	const tokens: ReactNode[] = [];
	let offset = 0;
	// Quoted > characters belong to attribute values. Match unfinished tags while typing, too.
	const markup = /<!--[\s\S]*?(?:-->|$)|<!doctype\b[^>]*(?:>|$)|<\/?[a-z][\w:-]*(?:"[^"]*(?:"|$)|'[^']*(?:'|$)|[^"'<>])*(?:>|(?=<|$))|&(?:#x[\da-f]+|#\d+|[a-z]\w*);/gi;
	for (const match of source.matchAll(markup)) {
		const [text] = match;
		const start = match.index;
		tokens.push(source.slice(offset, start));
		offset = start + text.length;
		const opening = /^<\/?[a-z][\w:-]*/i.exec(text)?.[0];
		if (!opening) {
			tokens.push(<span key={start} className={text.startsWith("<!--") ? COMMENT : text.startsWith("&") ? ENTITY : TAG}>{text}</span>);
			continue;
		}
		tokens.push(<span key={start} className={TAG}>{opening}</span>);
		const attributes = text.slice(opening.length);
		for (const part of attributes.matchAll(/(=\s*)("[^"]*(?:"|$)|'[^']*(?:'|$)|[^\s>]+)?|[^\s=/>]+|[\s\S]/g)) {
			const [token, assignment, attributeValue] = part;
			const key = start + opening.length + part.index;
			if (assignment) {
				tokens.push(assignment, <span key={key} className={VALUE}>{attributeValue}</span>);
			} else if (/^\s/.test(token)) {
				tokens.push(token);
			} else {
				tokens.push(<span key={key} className={token === "/" || token === ">" ? TAG : ATTRIBUTE}>{token}</span>);
			}
		}
	}
	tokens.push(source.slice(offset));
	return tokens;
}

type HtmlSourceEditorProps = Pick<ComponentProps<"textarea">, "id" | "disabled" | "onChange" | "onPaste"> & {
	value: string;
};

export function HtmlSourceEditor({ value, ...props }: HtmlSourceEditorProps) {
	const highlightRef = useRef<HTMLElement>(null);
	const gutterRef = useRef<HTMLSpanElement>(null);
	const lineNumbers = value.split("\n").map((_, index) => index + 1).join("\n");
	const deferredValue = useDeferredValue(value);
	const highlighted = useMemo(
		() => deferredValue.length <= MAX_HIGHLIGHT_LENGTH ? highlightHtml(deferredValue) : null,
		[deferredValue],
	);
	const showHighlight = value === deferredValue && highlighted !== null;

	return (
		<div className="flex min-h-0 flex-1 bg-[#18191b] [color-scheme:dark]" dir="ltr">
			<pre
				aria-hidden="true"
				className={cn("m-0 min-w-10 shrink-0 select-none overflow-hidden border-r border-white/10 bg-[#202124] px-2 text-right text-[#a1a8b3] forced-colors:border-[CanvasText]", CODE_LAYOUT)}
			>
				<span ref={gutterRef} className="block">{lineNumbers}</span>
			</pre>
			<div className="relative min-h-0 min-w-0 flex-1">
				<pre
					aria-hidden="true"
					className={cn("pointer-events-none absolute inset-0 m-0 overflow-hidden px-4 text-[#f0f0f0] forced-colors:hidden", !showHighlight && "invisible", CODE_LAYOUT)}
				>
					<code ref={highlightRef} className="block w-max [font-family:inherit]">{highlighted}</code>
				</pre>
				<textarea
					{...props}
					value={value}
					wrap="off"
					spellCheck={false}
					autoCapitalize="off"
					onScroll={({ currentTarget }) => {
						if (gutterRef.current) gutterRef.current.style.transform = `translateY(${-currentTarget.scrollTop}px)`;
						if (highlightRef.current) {
							highlightRef.current.style.transform = "translate(" + -currentTarget.scrollLeft + "px, " + -currentTarget.scrollTop + "px)";
						}
					}}
					className={cn(
						"relative block h-full w-full resize-none overflow-auto border-0 bg-transparent px-4 caret-[#f0f0f0] selection:bg-cyan-400/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-cyan-500 forced-colors:bg-[Canvas] forced-colors:text-[CanvasText] forced-colors:caret-[CanvasText]",
						showHighlight ? "text-transparent selection:text-transparent" : "text-[#f0f0f0]",
						CODE_LAYOUT,
					)}
				/>
			</div>
		</div>
	);
}
