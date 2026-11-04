import { ChevronRight } from "@/components/icons";
import { useLanguage } from "@/components/language-provider";
import type { PreviousMessageProps } from "./previous-message-types";

export function PreviousMessage({ message }: PreviousMessageProps) {
	const { t } = useLanguage();
	return (
		<details className="group mt-4 border-l-2 border-neutral-200 pl-4">
			<summary className="flex cursor-pointer list-none items-center gap-2 rounded-md py-2 text-xs font-medium text-neutral-500 hover:text-neutral-800">
				<ChevronRight className="h-3.5 w-3.5 shrink-0 transition-transform group-open:rotate-90" />
				<span>
					{t(message.direction === "sent" ? "message.previous.sent" : "message.previous.received", { date: message.dateLine })}
				</span>
			</summary>
			<div className="pb-2 pl-5 text-neutral-600">
				{message.content && (
					<pre className="whitespace-pre-wrap text-sm font-sans">
						{message.content}
					</pre>
				)}
				{message.quotedContent.map((nestedMessage, index) => (
					<PreviousMessage
						key={`${nestedMessage.dateLine}-${nestedMessage.content.slice(0, 24)}-${index}`}
						message={nestedMessage}
					/>
				))}
			</div>
		</details>
	);
}
