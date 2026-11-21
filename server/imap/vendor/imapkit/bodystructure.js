/*
 * Ported from imapkit 5.3.2 (https://github.com/postalsys/imapkit), dist/esm/bodystructure.js, with only this notice added.
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
// Converts a parsed MIME tree into BODY and BODYSTRUCTURE data. Ported from WildDuck
// (imap-core/lib/indexer/body-structure.js)
import envelope from './envelope.js';
import { partsOf, embeddedMessage } from './mimeparser.js';
// Expose to the world
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
function createBodystructure(tree, options) {
    options = options || {};
    const key = (name) => (options.upperCaseKeys && typeof name === 'string' ? name.toUpperCase() : name);
    // Parameter list of a parsed structured header value, as the flat `(key value key value)` list
    const paramList = (parsed) => {
        if (!parsed || !parsed.hasParams) {
            return null;
        }
        const list = [];
        // hasParams is only set together with params
        const params = parsed.params;
        Object.keys(params).forEach(name => {
            list.push(key(name), params[name]);
        });
        return list.length ? list : null;
    };
    const getBasicFields = (node) => {
        const contentType = node.parsedHeader['content-type'] || {};
        let bodyType = contentType.type || null;
        let bodySubtype = contentType.subtype || null;
        if (!bodyType || !bodySubtype) {
            // prevent strange content types like (NIL "/ms-word") that may break some clients
            if (bodyType === 'text' || bodySubtype === 'plain') {
                bodyType = 'text';
                bodySubtype = 'plain';
            }
            else {
                bodyType = 'application';
                bodySubtype = 'octet-stream';
            }
        }
        return [
            key(bodyType),
            key(bodySubtype),
            // body parameter parenthesized list
            paramList(contentType),
            // body id
            node.parsedHeader['content-id'] || null,
            // body description
            node.parsedHeader['content-description'] || null,
            // body encoding
            key(node.parsedHeader['content-transfer-encoding'] || '7bit'),
            // body size
            node.size
        ];
    };
    // The extension fields every part has (a non-multipart part also has an MD5 before them)
    const getExtensionFields = (node) => {
        const languageString = node.parsedHeader['content-language'] && node.parsedHeader['content-language'].replace(/[ ,]+/g, ',').replace(/^,+|,+$/g, '');
        const language = (languageString && languageString.split(',')) || null;
        const disposition = node.parsedHeader['content-disposition'];
        const data = [
            // body disposition
            (disposition && [key(disposition.value), paramList(disposition)]) || null,
            // body language
            language
        ];
        // NB! RFC3501 has an errata with content-location type, it is described as
        // "A string list" (eg. an array) in RFC but the errata page states
        // that it is a string (http://www.rfc-editor.org/errata_search.php?rfc=3501)
        // see note for "Section 7.4.2, page 75"
        if (!options.skipContentLocation) {
            data.push(node.parsedHeader['content-location'] || null);
        }
        return data;
    };
    // A non-multipart node: the basic fields, the fields of its type (line count for text, envelope and
    // structure for message/rfc822), and the extension fields unless BODY was asked for
    const processLeaf = (node, extra) => {
        let data = getBasicFields(node).concat(extra);
        if (!options.body) {
            data = data.concat([node.parsedHeader['content-md5'] || null], getExtensionFields(node));
        }
        return data;
    };
    const processMultipartNode = (node) => {
        // only called for a node with parts
        let data = partsOf(node)
            .map(walker)
            .concat([key(node.multipart)]);
        if (!options.body) {
            // RFC 3501 7.4.2: BODY is BODYSTRUCTURE without extension data, and for a multipart the
            // parameter list is the first extension field (body-ext-mpart)
            data = data.concat([paramList(node.parsedHeader['content-type'])], getExtensionFields(node));
        }
        // body-type-mpart = 1*body SP media-subtype, there is no SP between the bodies (RFC 3501 section 9)
        Object.defineProperty(data, 'adjacentLists', { value: true });
        return data;
    };
    const walker = (node) => {
        const contentType = node.parsedHeader['content-type'] || {};
        switch (contentType.type) {
            case 'multipart':
                // a multipart without a boundary parameter has no parts and is described with the
                // basic fields (RFC 3501 body-type-mpart needs at least one body)
                return partsOf(node) ? processMultipartNode(node) : processLeaf(node, []);
            case 'text':
                return processLeaf(node, [node.lineCount]);
            case 'message': {
                // RFC 2045 5.1: the subtype is not case sensitive. Other message subtypes, such as
                // message/delivery-status, are described as basic parts. RFC 9051 section 9 media-message
                // adds message/global, RFC 3501 body-type-basic describes it as a basic part
                // (embeddedMessage() only returns the message of these types)
                const embedded = embeddedMessage(node, options.messageGlobal);
                if (embedded) {
                    return processLeaf(node, [envelope(embedded.parsedHeader), walker(embedded), node.lineCount]);
                }
                return processLeaf(node, []);
            }
            default:
                return processLeaf(node, []);
        }
    };
    return walker(tree);
}
