/*
 * Ported from imapkit 5.3.2 (https://github.com/postalsys/imapkit), dist/esm/envelope.js, modified by Mailflare contributors (limits on nesting, part count and header field sizes; see NOTICE).
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
// This module converts message structure into an ENVELOPE object
// RFC 5322 section 4.4: obs-angle-addr = [CFWS] "<" obs-route addr-spec ">" [CFWS], obs-route = obs-domain-list ":",
// obs-domain-list = *(CFWS / ",") "@" domain *("," [CFWS] ["@" domain]). A domain-literal can hold a colon
const OBS_ROUTE = /^[\s,]*(@(?:[^:[]|\[[^\]]*\])*):/;
/**
 * Splits an obsolete source route from an address: the route goes to addr-adl, the rest is the addr-spec
 * (RFC 9051 section 7.5.2: the at-domain-list is the "source route and obs-route ABNF production from [RFC5322]",
 * the mailbox name the "local-part ABNF production"). The route is sent like Dovecot does, "@a,@b"
 *
 * @param {String} address Address from the angle brackets
 * @return {Array} [route or null, addr-spec]
 */
function splitRoute(address) {
    const match = address.match(OBS_ROUTE);
    if (!match) {
        return [null, address];
    }
    const route = match[1]
        .split(',')
        .map(domain => domain.trim())
        .filter(domain => domain)
        .join(',');
    return [route, address.substr(match[0].length).trim()];
}
/**
 * Convert a message object to an ENVELOPE object
 *
 * @param {Object} header Parsed header of a mime tree node
 * @return {Object} ENVELOPE compatible object
 */
export default function envelope(header) {
    // RFC 3501 9: env-date and env-subject are nstring, NIL when the header is missing
    const subject = header.subject;
    return [
        header.date || null,
        typeof subject === 'string' ? subject : null,
        processAddress(header.from),
        processAddress(header.sender, header.from),
        processAddress(header['reply-to'], header.from),
        processAddress(header.to),
        processAddress(header.cc),
        processAddress(header.bcc),
        // If this is an embedded MESSAGE/RFC822, then Gmail seems to
        // have a bug here, it states '"NIL"' as the value, not 'NIL'
        header['in-reply-to'] || null,
        header['message-id'] || null
    ];
}
/**
 * Converts an address object to a list of arrays
 * [{name: "User Name", addres:"user@example.com"}] -> [["User Name", null, "user", "example.com"]]
 *
 * @param {Array} arr An array of address objects
 * @return {Array} A list of addresses
 */
function processAddress(arr, def) {
    let list = [].concat(arr || []);
    if (!list.length) {
        list = [].concat(def || []);
    }
    if (!list.length) {
        return null;
    }
    const result = [];
    list.forEach(addr => {
        if (addr.group) {
            // Handle group syntax
            result.push([null, null, addr.name || '', null]);
            for (const member of processAddress(addr.group) || []) {
                result.push(member);
            }
            result.push([null, null, null, null]);
            return;
        }
        let name = addr.name || null;
        let address = addr.address || '';
        if (!address && name) {
            // a bare word ("To: localuser") is the mailbox, not the name
            address = name;
            name = null;
        }
        if (!address) {
            return;
        }
        const [route, addrSpec] = splitRoute(address);
        address = addrSpec;
        const at = address.lastIndexOf('@');
        const user = at >= 0 ? address.substr(0, at) : address;
        // RFC 3501 7.4.2 reserves a NIL host for group markers, so an address without a domain gets
        // the placeholder host that Dovecot uses for the same input
        const domain = (at >= 0 ? address.substr(at + 1) : '') || 'MISSING_DOMAIN';
        result.push([name, route, user || null, domain]);
    });
    // env-from = "(" 1*address ")", there is no SP between the addresses (RFC 3501 section 9)
    Object.defineProperty(result, 'adjacentLists', { value: true });
    return result.length ? result : null;
}
export { processAddress };
