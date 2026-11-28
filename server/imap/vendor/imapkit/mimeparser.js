/*
 * Ported from imapkit 5.3.2 (https://github.com/postalsys/imapkit), dist/esm/mimeparser.js, modified by Mailflare contributors (limits on nesting, part count and header field sizes; see NOTICE).
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
// Parses a message into a MIME tree. Ported from WildDuck (imap-core/lib/indexer/parse-mime-tree.js and
// tree-walker.js), adapted to ImapKit, where message sources are binary strings (one char per octet).
//
// The tree describes the message exactly, so every section a client can FETCH is rendered from it:
//
//     entity    = header-lines [ CRLF body ]            ; "CRLF body" present unless hasBody is false
//     body      = bytes | preamble *( delimiter entity CRLF ) close-delimiter epilogue
//     delimiter = "--" boundary pad CRLF
//
// The CRLF after an entity belongs to the delimiter that follows it (RFC 2046 5.1.1), a part body never
// includes it.
import addressparser from './addressparser.js';
// header field and parameter names that are kept in the parsed header, anything else is only available
// through the raw header lines
const FIELD_NAME = /^[a-zA-Z0-9\-*]{1,99}$/;
// content transfer encodings that leave the data as it is (RFC 2045 section 6.2)
const IDENTITY_ENCODINGS = ['7bit', '8bit', 'binary'];
// message/rfc822 parts nested deeper than this are not parsed, they are described as plain parts
const MAX_MESSAGE_DEPTH = 32;
// Limits on what is parsed. A multipart nested deeper than MAX_NESTING (counted over multiparts and
// message/rfc822 parts together) and parts beyond MAX_PARTS (counted over the whole message, embedded messages
// included) are not split: the text stays in the body of the part that holds it, which is still described
// and served byte for byte. An address field longer than MAX_ADDRESS_FIELD characters is not parsed.
const MAX_NESTING = 64;
const MAX_PARTS = 1000;
const MAX_ADDRESS_FIELD = 16384;
// message/rfc822 bodies are parsed again as messages of their own. Those parses together cover at most
// EMBEDDED_FACTOR times the input (and at least EMBEDDED_FLOOR characters); an embedded message beyond
// that is described as a plain part, so the work stays in proportion to the size of the message.
const EMBEDDED_FACTOR = 4;
const EMBEDDED_FLOOR = 1024 * 1024;
const isSpace = (chr) => /\s/.test(chr);
/**
 * Replaces every run of white space that holds a line break with one space (header folding, RFC 5322 2.2.3),
 * in one pass over the value
 *
 * @param {String} value Header value
 * @return {String} Unfolded value
 */
function unfold(value) {
    if (value.indexOf('\n') < 0) {
        return value;
    }
    const out = [];
    let i = 0;
    while (i < value.length) {
        let j = i;
        if (isSpace(value.charAt(i))) {
            let lineBreak = false;
            while (j < value.length && isSpace(value.charAt(j))) {
                lineBreak = lineBreak || value.charAt(j) === '\n';
                j++;
            }
            out.push(lineBreak ? ' ' : value.slice(i, j));
        }
        else {
            while (j < value.length && !isSpace(value.charAt(j))) {
                j++;
            }
            out.push(value.slice(i, j));
        }
        i = j;
    }
    return out.join('');
}
/**
 * Removes quotes and white space from both ends of a parameter value, in one pass
 *
 * @param {String} value Parameter value
 * @return {String} Value without those characters at its ends
 */
function stripEdges(value) {
    const strip = (chr) => chr === "'" || chr === '"' || isSpace(chr);
    let start = 0;
    let end = value.length;
    while (start < end && strip(value.charAt(start))) {
        start++;
    }
    while (end > start && strip(value.charAt(end - 1))) {
        end--;
    }
    return value.slice(start, end);
}
/**
 * Converts every line break of a message to CRLF. IMAP serves messages with CRLF line breaks, so sizes and
 * contents are computed from this form
 *
 * @param {String} raw Message source as a binary string
 * @return {String} Message source with CRLF line breaks
 */
function normalizeLineBreaks(raw) {
    const str = Buffer.isBuffer(raw) ? raw.toString('binary') : raw || '';
    // most messages already use CRLF, so only replace if there is a bare LF
    return /(?:^|[^\r])\n/.test(str) ? str.replace(/\r?\n/g, '\r\n') : str;
}
/**
 * Splits a structured header value (RFC 2045 5.1 Content-Type and friends) at a separator character,
 * leaving quoted strings intact and dropping RFC 822 comments outside of them. With no separator the
 * whole value comes back as one part with its comments removed.
 *
 * @param {String} value Header value
 * @param {String} [separator] Character to split at, outside quotes and comments
 * @returns {Array} Parts
 */
function splitStructuredValue(value, separator) {
    const parts = [];
    let current = '';
    let quoted = false;
    let depth = 0;
    for (let i = 0; i < value.length; i++) {
        const chr = value.charAt(i);
        if (quoted) {
            current += chr;
            if (chr === '\\' && i + 1 < value.length) {
                // quoted-pair, keep the escaped character for the value parser
                current += value.charAt(++i);
            }
            else if (chr === '"') {
                quoted = false;
            }
            continue;
        }
        if (depth) {
            // inside a comment, which may nest and may hold quoted-pairs
            if (chr === '\\') {
                i++;
            }
            else if (chr === '(') {
                depth++;
            }
            else if (chr === ')') {
                depth--;
            }
            continue;
        }
        if (chr === '"') {
            quoted = true;
            current += chr;
        }
        else if (chr === '(') {
            depth = 1;
        }
        else if (separator && chr === separator) {
            parts.push(current);
            current = '';
        }
        else {
            current += chr;
        }
    }
    parts.push(current);
    return parts;
}
/**
 * Decodes an RFC 2231 extended parameter value (percent encoded octets in a charset). UTF-8 and US-ASCII
 * values become the UTF-8 octets, ISO-8859-1 values are converted to UTF-8, other charsets are kept as
 * an RFC 2047 encoded word
 *
 * @param {String} charset Charset name from the first segment
 * @param {String} value Percent encoded octets
 * @return {String} Decoded value as a binary string
 */
function decodeExtendedValue(charset, value) {
    const octets = value.replace(/%([0-9a-fA-F]{2})/g, (match, hex) => String.fromCharCode(parseInt(hex, 16)));
    switch ((charset || '').trim().toLowerCase()) {
        case '':
        case 'utf-8':
        case 'utf8':
        case 'us-ascii':
        case 'ascii':
            return octets;
        case 'iso-8859-1':
        case 'latin1':
            // every char of the binary string is an ISO-8859-1 character
            return Buffer.from(octets, 'utf-8').toString('binary');
        default:
            return '=?' + charset.toUpperCase() + '?Q?' + value.replace(/%/g, '=') + '?=';
    }
}
class MIMEParser {
    /**
     * @param {String} rfc822 Message source as a binary string with CRLF line breaks
     * @param {Number} [depth] How many message/rfc822 levels this message is nested in
     * @param {Object} [budget] Parts created so far and characters left for embedded message parses, shared with the messages nested in this one
     * @param {Number} [level] Nesting level of the part that holds this message
     */
    constructor(rfc822, depth, budget, level) {
        this.rfc822 = rfc822 || '';
        this.depth = depth || 0;
        this.budget = budget || { parts: 0, embedded: Math.max(this.rfc822.length * EMBEDDED_FACTOR, EMBEDDED_FLOOR) };
        // the line break that ended the last line read, false once the input is used up
        this._br = '';
        this._pos = 0;
        this.tree = {
            childNodes: [],
            level: level || 0
        };
        this._node = this.createNode(this.tree);
    }
    /**
     * Parses the message, line by line
     */
    parse() {
        let line;
        let prevBr = '';
        // keep parsing until the last linebreak is not a string (no linebreaks anymore)
        while (typeof this._br === 'string') {
            line = this.readLine();
            const delimiter = this.matchDelimiter(line);
            if (delimiter) {
                this.endPart(delimiter, prevBr);
            }
            else {
                switch (this._node.state) {
                    case 'header':
                        if (!line) {
                            // the blank line that separates the header from the body
                            this.endHeader();
                        }
                        else {
                            this._node.header.push(line);
                        }
                        break;
                    case 'body':
                        // push the line with previous linebreak value, joined together the lines
                        // give the original body
                        this._node.body.push((this._node.body.length ? prevBr : '') + line);
                        break;
                    case 'epilogue':
                        // RFC 2046 5.1.1: everything after the close delimiter up to the next delimiter
                        // of the enclosing multipart (or the end of the message) is the epilogue. Every
                        // epilogue line keeps the line break that precedes it, the first one being the
                        // line break that ends the close delimiter line
                        if (!this._node.epilogue) {
                            this._node.epilogue = [];
                        }
                        this._node.epilogue.push(prevBr + line);
                        break;
                    default:
                        // never should be reached
                        throw new Error('Unexpected state');
                }
            }
            // store the linebreak for later usage
            prevBr = this._br;
        }
    }
    /**
     * Reads a line from the message
     *
     * @return {String} The line, without its line break
     */
    readLine() {
        const end = this.rfc822.indexOf('\n', this._pos);
        if (end < 0) {
            // the remainder, which is empty when the input ended with a line break
            const line = this.rfc822.slice(this._pos);
            this._pos = this.rfc822.length;
            this._br = false;
            return line;
        }
        let lineEnd = end;
        if (lineEnd > this._pos && this.rfc822.charCodeAt(lineEnd - 1) === 0x0d) {
            lineEnd--;
        }
        const line = this.rfc822.slice(this._pos, lineEnd);
        this._br = this.rfc822.slice(lineEnd, end + 1);
        this._pos = end + 1;
        return line;
    }
    /**
     * Ends the header of the current node: its blank line was read, or a delimiter took its place
     */
    endHeader() {
        this.processNodeHeader();
        this.processContentType();
        this._node.state = 'body';
    }
    /**
     * Checks whether a line is a delimiter of an open multipart: the current node while it collects its
     * preamble or epilogue, the multipart the current node belongs to, or any multipart above that (a
     * lost close delimiter leaves the inner multipart open, the enclosing delimiter still ends it).
     * RFC 2046 5.1.1: `--boundary` or `--boundary--`, optionally followed by transport padding (spaces
     * and tabs) that receivers must accept. After the close delimiter, lines that look like the own
     * delimiter are epilogue text.
     *
     * @param {String} line Line of the message
     * @return {Object|Boolean} `{ multipart, close, pad }`, or false when the line is not a delimiter
     */
    matchDelimiter(line) {
        if (!line.startsWith('--')) {
            return false;
        }
        const node = this._node;
        // a boundary is only known once the header has ended
        const innermost = node.boundary ? node : node.parentNode;
        for (let multipart = innermost; multipart.boundary; multipart = multipart.parentNode) {
            const delimiter = '--' + multipart.boundary;
            if (!line.startsWith(delimiter)) {
                continue;
            }
            let rest = line.slice(delimiter.length);
            const close = rest.startsWith('--');
            if (close) {
                rest = rest.slice(2);
            }
            if (/[^ \t]/.test(rest)) {
                // something other than padding after the boundary, so a different boundary or text
                continue;
            }
            if (!close && this.budget.parts >= MAX_PARTS) {
                // no more parts are split off, the line stays in the part that is open
                continue;
            }
            if (multipart.state === 'epilogue') {
                return false;
            }
            return { multipart, close, pad: rest };
        }
        return false;
    }
    /**
     * Ends whatever the current node was collecting at a delimiter line and moves on to the next
     * part of that multipart, or to its epilogue
     *
     * @param {Object} delimiter Result of matchDelimiter()
     * @param {String} prevBr The line break that ended the line before the delimiter
     */
    endPart(delimiter, prevBr) {
        const node = this._node;
        const multipart = delimiter.multipart;
        if (node !== multipart) {
            // a part ends here
            if (node.state === 'header') {
                // a delimiter right after the header lines, with no blank line and no line break of
                // its own (RFC 2046 5.1.1 wants one before every delimiter): the line break that ended
                // the last header line, or the previous delimiter line, is the only one there is
                this.endHeader();
                // the multiparts a lost close delimiter leaves open between this part and the one the
                // delimiter belongs to end with this part, so they end bare too
                for (let open = node; open !== multipart; open = open.parentNode) {
                    open.bare = true;
                }
            }
        }
        else if (node.body.length) {
            // the preamble ends here. The line break between the preamble and the delimiter belongs to
            // the delimiter, but the preamble lines end with their own
            node.body[node.body.length - 1] += prevBr;
        }
        if (!delimiter.close) {
            const next = this.createNode(multipart);
            if (delimiter.pad) {
                next.pad = delimiter.pad;
            }
            this._node = next;
        }
        else {
            if (delimiter.pad) {
                multipart.closePad = delimiter.pad;
            }
            delete multipart.unterminated;
            multipart.state = 'epilogue';
            this._node = multipart;
        }
    }
    /**
     * Parses the body of a message/rfc822 node into `node.message`. RFC 2046 5.2.1 only allows the
     * identity encodings for such a body, RFC 2045 5.1 and 6.1 make the type and encoding names case
     * insensitive. A message/global body (RFC 6532 section 3.5) goes to `node.globalMessage`, as only
     * IMAP4rev2 treats it like message/rfc822 (RFC 9051 section 7.5.2), see embeddedMessage()
     */
    parseEmbeddedMessage(node) {
        const contentType = node.parsedHeader['content-type'];
        const type = ((contentType && contentType.value) || '').toLowerCase();
        if ((type !== 'message/rfc822' && type !== 'message/global') || this.depth >= MAX_MESSAGE_DEPTH || node.level >= MAX_NESTING) {
            return;
        }
        const encoding = (node.parsedHeader['content-transfer-encoding'] || '').toString().trim().toLowerCase();
        if (encoding && !IDENTITY_ENCODINGS.includes(encoding)) {
            return;
        }
        if (node.body.length > this.budget.embedded) {
            return;
        }
        this.budget.embedded -= node.body.length;
        node[type === 'message/rfc822' ? 'message' : 'globalMessage'] = parseTree(node.body, this.depth + 1, this.budget, node.level);
    }
    /**
     * Joins body arrays into strings. Removes unnecessary fields from the tree
     */
    finalizeTree() {
        if (this._node.state === 'header') {
            this.endHeader();
            if (this._node.header.length && !this.rfc822.endsWith('\n')) {
                // the input ended within the last header line, there is no line break to render
                this._node.headerUnterminated = true;
            }
        }
        // iterative, so that deeply nested multiparts do not exhaust the stack
        const stack = [...this.tree.childNodes];
        while (stack.length) {
            const parsing = stack.pop();
            // the same object, from here on with its lines joined
            const node = parsing;
            const lines = parsing.body;
            // a body section holds lines, parts, or at least a close delimiter. A blank line followed by
            // the end of the input leaves the trailing empty line in the body, one followed directly by
            // a delimiter leaves nothing
            const closed = node.boundary && !node.unterminated;
            if (!(lines.length || parsing.childNodes.length || closed)) {
                node.hasBody = false;
            }
            // RFC 3501 7.4.2 body-fld-lines, counted like Dovecot does: the line breaks in the body
            node.lineCount = lines.length ? lines.length - 1 : 0;
            node.body = lines.join('');
            node.size = node.body.length;
            // a message/rfc822 entity carries its parsed message
            this.parseEmbeddedMessage(node);
            if (parsing.epilogue) {
                node.epilogue = parsing.epilogue.join('');
            }
            parsing.childNodes.forEach(child => stack.push(child));
            // remove unneeded properties
            delete parsing.parentNode;
            delete parsing.state;
            if (!node.childNodes.length) {
                delete node.childNodes;
            }
        }
    }
    /**
     * Creates a new node with default values for the parse tree
     */
    createNode(parentNode) {
        const node = {
            state: 'header',
            childNodes: [],
            header: [],
            parsedHeader: Object.create(null),
            body: [],
            multipart: false,
            boundary: false,
            level: parentNode.level + 1,
            parentNode
        };
        this.budget.parts++;
        parentNode.childNodes.push(node);
        return node;
    }
    /**
     * Processes header lines. Splits lines to key-value pairs
     * and processes special values
     */
    processNodeHeader() {
        const node = this._node;
        // the fields hold raw values until they are parsed below
        const fields = node.parsedHeader;
        // RFC 5322 2.2.3: a line that starts with whitespace continues the previous header field
        const header = [];
        for (const line of node.header) {
            if (header.length && /^\s/.test(line)) {
                header[header.length - 1] += '\r\n' + line;
            }
            else {
                header.push(line);
            }
        }
        node.header = header;
        for (const line of header) {
            const parts = line.split(':');
            const key = (parts.shift() || '').trim().toLowerCase();
            const value = parts.join(':').trim();
            // Do not touch headers that have strange looking keys, keep these
            // only in the unparsed array
            if (!FIELD_NAME.test(key)) {
                continue;
            }
            if (key in fields) {
                if (Array.isArray(fields[key])) {
                    fields[key].push(value);
                }
                else {
                    fields[key] = [fields[key], value];
                }
            }
            else {
                fields[key] = unfold(value);
            }
        }
        // always ensure the presence of Content-Type. RFC 2046 5.1.5: inside a digest the default
        // is message/rfc822 instead of text/plain
        if (!fields['content-type']) {
            const parentSubtype = ((node.parentNode && node.parentNode.multipart) || '').toString().toLowerCase();
            fields['content-type'] = parentSubtype === 'digest' ? 'message/rfc822' : 'text/plain';
        }
        // parse additional params for Content-Type and Content-Disposition, the last header wins
        ['content-type', 'content-disposition'].forEach(key => {
            if (fields[key]) {
                fields[key] = this.parseValueParams([].concat(fields[key]).pop());
            }
        });
        // ensure single value for selected fields, the last header wins
        [
            'subject',
            'date',
            'in-reply-to',
            'message-id',
            'content-transfer-encoding',
            'content-id',
            'content-description',
            'content-language',
            'content-md5',
            'content-location'
        ].forEach(key => {
            if (Array.isArray(fields[key])) {
                fields[key] = unfold(fields[key].pop());
            }
        });
        if (fields['content-transfer-encoding']) {
            // RFC 2045 6.1: the mechanism token may be followed by a comment, which is not part of it
            fields['content-transfer-encoding'] = splitStructuredValue(fields['content-transfer-encoding'])[0].trim();
        }
        // Parse address fields (join several fields with same key)
        ['from', 'sender', 'reply-to', 'to', 'cc', 'bcc'].forEach(key => {
            if (fields[key]) {
                const values = [].concat(fields[key]);
                // a field this long is left unparsed, its ENVELOPE entry is NIL
                const length = values.reduce((total, value) => total + (value ? value.length : 0), 0);
                fields[key] = length > MAX_ADDRESS_FIELD ? [] : values.flatMap(value => (value && addressparser(unfold(value))) || []);
            }
        });
    }
    /**
     * Splits a value to an object.
     * eg. 'text/plain; charset=utf-8' -> {value: 'text/plain', params:{charset: 'utf-8'}}
     *
     * @param {String} headerValue A string value for a header key
     * @return {Object} Parsed value
     */
    parseValueParams(headerValue) {
        const data = {
            value: '',
            type: '',
            subtype: '',
            params: Object.create(null)
        };
        // RFC 2231 continuations and extended values, by parameter name
        const continuations = Object.create(null);
        splitStructuredValue(headerValue || '', ';').forEach((part, i) => {
            if (!i) {
                data.value = part.trim();
                const subtype = data.value.split('/');
                data.type = (subtype.shift() || '').toLowerCase();
                data.subtype = subtype.join('/');
                return;
            }
            const parts = part.split('=');
            const key = (parts.shift() || '').trim().toLowerCase();
            let value = parts.join('=').trim();
            if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
                // RFC 2045 5.1 quoted-string: the quotes are not part of the value and a backslash
                // quotes the character after it (RFC 822 3.3)
                value = value.slice(1, -1).replace(/\\([\s\S])/g, '$1');
            }
            else {
                value = stripEdges(value);
            }
            // Do not touch parameters that have strange looking keys
            if (!FIELD_NAME.test(key)) {
                return;
            }
            // RFC 2231 3 and 4: `name*N` is segment N of a continued value, a trailing asterisk marks
            // a segment as extended (percent encoded, the first one prefixed with charset'language')
            const match = key.match(/^([^*]+)(?:\*(\d{1,3}))?(\*)?$/);
            if (match && (match[2] !== undefined || match[3])) {
                const name = match[1];
                if (!continuations[name]) {
                    continuations[name] = [];
                }
                continuations[name][Number(match[2]) || 0] = { value, extended: !!match[3] };
            }
            else {
                data.params[key] = value;
            }
            data.hasParams = true;
        });
        Object.keys(continuations).forEach(key => {
            let charset = '';
            let encoded = '';
            let extended = false;
            continuations[key].forEach((segment, i) => {
                if (!segment) {
                    return;
                }
                let value = segment.value;
                if (segment.extended && !i) {
                    const parts = value.split("'");
                    if (parts.length >= 3) {
                        charset = parts.shift();
                        parts.shift(); // language, ignored
                        value = parts.join("'");
                    }
                }
                if (segment.extended) {
                    extended = true;
                    encoded += value;
                }
                else {
                    // a segment that is not extended is plain text, encode it like the rest
                    encoded += value.replace(/[^\x21-\x24\x26-\x7e]/g, chr => '%' + ('0' + chr.charCodeAt(0).toString(16)).substr(-2));
                }
            });
            data.params[key] = extended ? decodeExtendedValue(charset, encoded) : decodeExtendedValue('', encoded);
        });
        return data;
    }
    /**
     * Checks Content-Type value for the current tree node.
     */
    processContentType() {
        const node = this._node;
        // processNodeHeader() always sets a Content-Type
        const contentType = node.parsedHeader['content-type'];
        if (contentType.type === 'multipart' && contentType.params.boundary && node.level <= MAX_NESTING) {
            node.multipart = contentType.subtype;
            node.boundary = contentType.params.boundary;
            // until the close delimiter is seen
            node.unterminated = true;
        }
    }
}
/**
 * Parses a message into a MIME tree
 *
 * @param {String} rfc822 Message source as a binary string with CRLF line breaks
 * @param {Number} [depth] Nesting level of message/rfc822 parts
 * @param {Object} [budget] Parts created so far and characters left for embedded message parses, `{ parts, embedded }`, shared with the messages nested in this one
 * @param {Number} [level] Nesting level of the part that holds this message
 * @return {Object} Root node of the tree
 */
function parseTree(rfc822, depth, budget, level) {
    const parser = new MIMEParser(rfc822, depth, budget, level);
    parser.parse();
    parser.finalizeTree();
    // finalizeTree() turned the nodes into MimeNodes
    return parser.tree.childNodes[0];
}
// RFC 3501 9: body-type-mpart = 1*body SP media-subtype. A multipart whose boundary never appeared has
// no parts, so this empty text part stands in for them
const PLACEHOLDER_PART = parseTree('Content-Type: text/plain\r\n\r\n');
/**
 * The parts of a node as IMAP numbers them: the parts of a multipart (the placeholder when it has none),
 * undefined for anything else
 *
 * @param {Object} node A tree node
 * @returns {Array|undefined} Part nodes
 */
function partsOf(node) {
    if (node.childNodes) {
        return node.childNodes;
    }
    return node.boundary ? [PLACEHOLDER_PART] : undefined;
}
/**
 * The message encapsulated in a node: the message of a message/rfc822 part, and with `global` also of a
 * message/global part (RFC 9051 sections 6.4.5.1 and 7.5.2, IMAP4rev1 treats message/global as a basic part)
 *
 * @param {Object} node A tree node
 * @param {Boolean} [global] Treat message/global like message/rfc822
 * @returns {Object|undefined} Root node of the encapsulated message
 */
function embeddedMessage(node, global) {
    return node.message || (global ? node.globalMessage : undefined);
}
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
function resolveNode(tree, path, global) {
    // the message whose parts the next number counts
    let scope = tree;
    let node = tree;
    for (const number of (path || '').toString().split('.')) {
        const index = Number(number) - 1;
        if (!scope || !(index >= 0)) {
            return false;
        }
        const parts = partsOf(scope);
        node = parts ? parts[index] : index === 0 ? scope : undefined;
        if (!node) {
            return false;
        }
        scope = embeddedMessage(node, global) || (partsOf(node) ? node : false);
    }
    return node;
}
/**
 * The header of a node as the HEADER and MIME sections return it, with the blank line that ends it
 *
 * @param {Object} node Tree node
 * @return {String} Header section
 */
function headerSection(node) {
    const header = node.header || [];
    if (node.hasBody === false) {
        // RFC 3501 7.4.2: the blank line is part of the header, except for a message with no body and no blank line
        return header.length ? header.join('\r\n') + (node.headerUnterminated ? '' : '\r\n') : '';
    }
    return header.length ? header.join('\r\n') + '\r\n\r\n' : '\r\n';
}
/**
 * Renders a node of the tree back to the octets it was parsed from
 *
 * @param {Object} node Tree node
 * @param {Boolean} [textOnly] Leave out the header of the node (BODY[TEXT], BODY[n])
 * @return {String} Binary string
 */
function render(node, textOnly) {
    const output = [];
    const walk = (node, withHeader) => {
        if (withHeader) {
            const header = node.header || [];
            if (header.length) {
                output.push(header.join('\r\n') + (node.headerUnterminated ? '' : '\r\n'));
            }
        }
        if (node.hasBody === false) {
            return;
        }
        if (withHeader) {
            // the blank line between header and body
            output.push('\r\n');
        }
        output.push(node.body || '');
        if (!node.boundary) {
            return;
        }
        const children = node.childNodes || [];
        for (let i = 0; i < children.length; i++) {
            const child = children[i];
            output.push('--' + node.boundary + (child.pad || '') + '\r\n');
            walk(child, true);
            if ((!node.unterminated || i < children.length - 1) && !child.bare) {
                // the line break that belongs to the next delimiter
                output.push('\r\n');
            }
        }
        if (!node.unterminated) {
            output.push('--' + node.boundary + '--' + (node.closePad || ''));
            output.push(node.epilogue || '');
        }
    };
    walk(node, !textOnly);
    return output.join('');
}
// Parsed data of messages, so a message is parsed only once and not again until its source changes
const cache = new WeakMap();
/**
 * Returns the source with CRLF line breaks and the MIME tree of a message
 *
 * @param {Object} message Message object with a `raw` property
 * @return {Object} `{ raw, tree }`
 */
function getMessageData(message) {
    let cached = cache.get(message);
    if (!cached || cached.source !== message.raw) {
        const raw = normalizeLineBreaks(message.raw);
        cached = { source: message.raw, raw, tree: parseTree(raw) };
        cache.set(message, cached);
    }
    return cached;
}
export default function mimeparser(rfc822) {
    return parseTree(normalizeLineBreaks(rfc822));
}
export { parseTree, IDENTITY_ENCODINGS, getMessageData, normalizeLineBreaks, partsOf, resolveNode, embeddedMessage, headerSection, render };
