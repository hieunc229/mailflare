/*
 * Ported from imapkit 5.3.2 (https://github.com/postalsys/imapkit), dist/esm/bodystructure.d.ts, with only this notice added.
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
import type { MimeNode } from './mimeparser.js';
import type { Attribute } from './types.js';
/** Options of createBodystructure() */
export interface BodystructureOptions {
    upperCaseKeys?: boolean | undefined;
    skipContentLocation?: boolean | undefined;
    body?: boolean | undefined;
    messageGlobal?: boolean | undefined;
}
/** A BODY or BODYSTRUCTURE list, nested lists for the parts, compiled by imap-handler */
export type Bodystructure = Attribute[];
export default createBodystructure;
/**
 * Generates an object out of parsed mime tree, that can be
 * serialized into a BODYSTRUCTURE string
 *
 * @param {Object} tree Parsed mime tree (see mimeparser.ts for input)
 * @param {Object} [options] Optional options object
 * @param {Boolean} [options.upperCaseKeys] If true, use only upper case key names
 * @param {Boolean} [options.skipContentLocation] If true, do not include Content-Location in the output
 * @param {Boolean} [options.body] If true, skip extension fields (needed for BODY)
 * @param {Boolean} [options.messageGlobal] If true, describe message/global like message/rfc822 (IMAP4rev2, RFC 9051 section 7.5.2)
 * @return {Array} Object structure in the form of BODYSTRUCTURE
 */
declare function createBodystructure(tree: MimeNode, options?: BodystructureOptions | null): Bodystructure;
