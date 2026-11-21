/*
 * Ported from imapkit 5.3.2 (https://github.com/postalsys/imapkit), dist/esm/envelope.d.ts, modified by Mailflare contributors (limits on nesting, part count and header field sizes; see NOTICE).
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
import type { ParsedHeader } from './mimeparser.js';
/** An address of the ENVELOPE (RFC 3501 section 9): name, source route, mailbox and host, all NIL for a group end */
export type EnvelopeAddress = [name: string | null, adl: string | null, mailbox: string | null, host: string | null];
/** The fields of the ENVELOPE (RFC 3501 section 7.4.2), in order */
export type Envelope = [
    date: string | null,
    subject: string | null,
    from: EnvelopeAddress[] | null,
    sender: EnvelopeAddress[] | null,
    replyTo: EnvelopeAddress[] | null,
    to: EnvelopeAddress[] | null,
    cc: EnvelopeAddress[] | null,
    bcc: EnvelopeAddress[] | null,
    inReplyTo: string | null,
    messageId: string | null
];
/**
 * Convert a message object to an ENVELOPE object
 *
 * @param {Object} header Parsed header of a mime tree node
 * @return {Object} ENVELOPE compatible object
 */
export default function envelope(header: ParsedHeader): Envelope;
/**
 * Converts an address object to a list of arrays
 * [{name: "User Name", addres:"user@example.com"}] -> [["User Name", null, "user", "example.com"]]
 *
 * @param {Array} arr An array of address objects
 * @return {Array} A list of addresses
 */
declare function processAddress(arr: ParsedAddress | ParsedAddress[] | undefined, def?: ParsedAddress | ParsedAddress[]): EnvelopeAddress[] | null;
export { processAddress };
