/*
 * Ported from imapkit 5.3.2 (https://github.com/postalsys/imapkit), dist/esm/mimeparser.d.ts, modified by Mailflare contributors (limits on nesting, part count and header field sizes; see NOTICE).
 * Copyright (c) 2013-2026 Postal Systems OÜ, MIT License:
 *
 * Copyright (c) 2013-2026 Postal Systems OÜ
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import type { ParsedAddress } from './addressparser.js';
import type { Message } from './types.js';
/** A structured header value (Content-Type, Content-Disposition) split into its parts */
export interface StructuredValue {
    /** the value without parameters, e.g. `text/plain` */
    value: string;
    /** lower case type, e.g. `text` */
    type: string;
    subtype: string;
    /** parameters by lower case name, RFC 2231 continuations joined and decoded */
    params: Record<string, string>;
    /** set when the value had parameters */
    hasParams?: boolean;
}
/**
 * The parsed header of a node, keyed by lower case field name. Fields that occur more than once are kept as a
 * list, except the ones listed in processNodeHeader(), where the last one wins
 */
export interface ParsedHeader {
    /** always present, processNodeHeader() sets a default */
    'content-type': StructuredValue;
    'content-disposition'?: StructuredValue;
    'content-transfer-encoding'?: string;
    from?: ParsedAddress[];
    sender?: ParsedAddress[];
    'reply-to'?: ParsedAddress[];
    to?: ParsedAddress[];
    cc?: ParsedAddress[];
    bcc?: ParsedAddress[];
    [key: string]: any;
}
/** A node of the parsed MIME tree, see the grammar at the top of this file */
export interface MimeNode {
    /** header lines, a folded field joined into one line with its CRLF */
    header: string[];
    parsedHeader: ParsedHeader;
    /** body octets (the preamble of a multipart) as a binary string */
    body: string;
    /** parts of a multipart, missing when there are none */
    childNodes?: MimeNode[];
    /** subtype of a multipart */
    multipart: string | false;
    boundary: string | false;
    /** size of the body in octets */
    size: number;
    /** line breaks in the body */
    lineCount: number;
    /** false when the entity has no blank line and no body after its header */
    hasBody?: boolean;
    /** the input ended within the last header line */
    headerUnterminated?: boolean;
    /** a multipart without a close delimiter */
    unterminated?: boolean;
    /** a part that ends without the line break that belongs to the next delimiter */
    bare?: boolean;
    /** transport padding after the delimiter before this part */
    pad?: string;
    /** transport padding after the close delimiter */
    closePad?: string;
    epilogue?: string;
    /** the parsed message of a message/rfc822 part */
    message?: MimeNode;
    /** the parsed message of a message/global part */
    globalMessage?: MimeNode;
    /** nesting level, counted over multiparts and message/rfc822 parts */
    level?: number;
}
declare const IDENTITY_ENCODINGS: string[];
/**
 * Converts every line break of a message to CRLF. IMAP serves messages with CRLF line breaks, so sizes and
 * contents are computed from this form
 *
 * @param {String} raw Message source as a binary string
 * @return {String} Message source with CRLF line breaks
 */
declare function normalizeLineBreaks(raw: string | Buffer): string;
/**
 * Parses a message into a MIME tree
 *
 * @param {String} rfc822 Message source as a binary string with CRLF line breaks
 * @param {Number} [depth] Nesting level of message/rfc822 parts
 * @param {Object} [budget] Parts created so far and characters left for embedded message parses, `{ parts, embedded }`, shared with the messages nested in this one
 * @param {Number} [level] Nesting level of the part that holds this message
 * @return {Object} Root node of the tree
 */
declare function parseTree(rfc822: string, depth?: number, budget?: { parts: number; embedded: number }, level?: number): MimeNode;
/**
 * The parts of a node as IMAP numbers them: the parts of a multipart (the placeholder when it has none),
 * undefined for anything else
 *
 * @param {Object} node A tree node
 * @returns {Array|undefined} Part nodes
 */
declare function partsOf(node: MimeNode): MimeNode[] | undefined;
/**
 * The message encapsulated in a node: the message of a message/rfc822 part, and with `global` also of a
 * message/global part (RFC 9051 sections 6.4.5.1 and 7.5.2, IMAP4rev1 treats message/global as a basic part)
 *
 * @param {Object} node A tree node
 * @param {Boolean} [global] Treat message/global like message/rfc822
 * @returns {Object|undefined} Root node of the encapsulated message
 */
declare function embeddedMessage(node: MimeNode, global?: boolean): MimeNode | undefined;
/**
 * Resolves a numeric part path to a node. RFC 3501 6.4.5: the parts of a multipart are numbered from 1,
 * a non-multipart message has one part which is the message itself, and the parts of a message/rfc822
 * part are numbered under it
 *
 * @param {Object} tree Root node
 * @param {String} path Dot-separated numeric path
 * @param {Boolean} [global] Number the parts of message/global parts too, like IMAP4rev2 does
 * @return {Object|Boolean} Node, or false when there is no such part
 */
declare function resolveNode(tree: MimeNode, path: string | number, global?: boolean): MimeNode | false;
/**
 * The header of a node as the HEADER and MIME sections return it, with the blank line that ends it
 *
 * @param {Object} node Tree node
 * @return {String} Header section
 */
declare function headerSection(node: MimeNode): string;
/**
 * Renders a node of the tree back to the octets it was parsed from
 *
 * @param {Object} node Tree node
 * @param {Boolean} [textOnly] Leave out the header of the node (BODY[TEXT], BODY[n])
 * @return {String} Binary string
 */
declare function render(node: MimeNode, textOnly?: boolean): string;
/**
 * Returns the source with CRLF line breaks and the MIME tree of a message
 *
 * @param {Object} message Message object with a `raw` property
 * @return {Object} `{ raw, tree }`
 */
declare function getMessageData(message: Message): {
    raw: string;
    tree: MimeNode;
};
export default function mimeparser(rfc822: string): MimeNode;
export { parseTree, IDENTITY_ENCODINGS, getMessageData, normalizeLineBreaks, partsOf, resolveNode, embeddedMessage, headerSection, render };
