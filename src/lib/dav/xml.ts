import { SaxesParser } from "saxes";

/** One parsed element. `ns` is the resolved namespace URI, so clients may use any prefix. */
export type DavElement = { ns: string; name: string; attrs: Record<string, string>; children: DavElement[]; text: string };

/** The body is not acceptable XML for DAV; the message is safe to show a client. */
export class DavXmlError extends Error {}

const MAX_DEPTH = 32;
const MAX_ELEMENTS = 20_000;
const MAX_TEXT = 64 * 1024;

/**
 * Parse a request body into a small tree. Anything that could expand or fetch
 * is refused instead of handled: a DOCTYPE (external entities, entity
 * bombs) and processing instructions other than the XML declaration. saxes
 * only knows the five predefined entities, so any other `&name;` is an error.
 * Never throws anything but DavXmlError.
 */
export function parseDavXml(input: string): DavElement {
	const parser = new SaxesParser({ xmlns: true });
	const stack: DavElement[] = [];
	let root: DavElement | null = null;
	let elements = 0;
	let failure: DavXmlError | null = null;
	const fail = (message: string) => {
		failure ??= new DavXmlError(message);
	};
	const addText = (text: string) => {
		const current = stack.at(-1);
		if (!current) return;
		current.text += text;
		if (current.text.length > MAX_TEXT) fail("Text content too large");
	};

	parser.on("error", (error) => fail(error.message));
	parser.on("doctype", () => fail("DOCTYPE is not allowed"));
	parser.on("processinginstruction", () => fail("Processing instructions are not allowed"));
	parser.on("opentag", (tag) => {
		if (++elements > MAX_ELEMENTS) return fail("Too many elements");
		if (stack.length >= MAX_DEPTH) return fail("Elements nested too deeply");
		const attrs: Record<string, string> = {};
		for (const attribute of Object.values(tag.attributes)) if (attribute.uri !== "http://www.w3.org/2000/xmlns/") attrs[attribute.local] = attribute.value;
		const element: DavElement = { ns: tag.uri, name: tag.local, attrs, children: [], text: "" };
		stack.at(-1)?.children.push(element);
		stack.push(element);
		root ??= element;
	});
	parser.on("closetag", () => void stack.pop());
	parser.on("text", addText);
	parser.on("cdata", addText);

	try {
		parser.write(input).close();
	} catch (error) {
		fail(error instanceof Error ? error.message : "Invalid XML");
	}
	if (failure) throw failure;
	if (!root) throw new DavXmlError("Empty document");
	return root;
}
