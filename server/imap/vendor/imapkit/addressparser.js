/*
 * Ported from imapkit 5.3.2 (https://github.com/postalsys/imapkit), dist/esm/addressparser.js, modified by Mailflare contributors (limits on nesting, part count and header field sizes; see NOTICE).
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
/**
 * Parses structured e-mail addresses from an address field
 *
 * Example:
 *
 *    "Name <address@domain>"
 *
 * will be converted to
 *
 *     [{name: "Name", address: "address@domain"}]
 *
 * @param {String} str Address field
 * @return {Array} An array of address objects
 */
export default function parse(str, inGroup) {
    const tokenizer = new Tokenizer(str);
    const tokens = tokenizer.tokenize();
    const addresses = [];
    let address = [];
    const parsedAddresses = [];
    tokens.forEach(token => {
        if (token.type === 'operator' && (token.value === ',' || token.value === ';')) {
            if (address.length) {
                addresses.push(address);
            }
            address = [];
        }
        else {
            address.push(token);
        }
    });
    if (address.length) {
        addresses.push(address);
    }
    addresses.forEach(address => {
        const handled = _handleAddress(address, inGroup);
        for (const entry of handled) {
            parsedAddresses.push(entry);
        }
    });
    return parsedAddresses;
}
const isSpace = (chr) => /\s/.test(chr);
const isWord = (chr) => /\w/.test(chr);
/**
 * Finds the first `local@domain` (neither part holds white space or another @, each starts and ends at a word
 * boundary) in a text and cuts it out together with the white space around it, in one pass
 *
 * @param {String} text Text of an address field
 * @return {Object|null} `{ address, rest }`, null when there is none
 */
function findAddress(text) {
    let start = 0;
    while (start < text.length) {
        if (isSpace(text.charAt(start))) {
            start++;
            continue;
        }
        let end = start;
        while (end < text.length && !isSpace(text.charAt(end))) {
            end++;
        }
        const found = findInWord(text.slice(start, end));
        if (found) {
            let from = start + found[0];
            let to = start + found[1];
            if (found[0] === 0) {
                while (from > 0 && isSpace(text.charAt(from - 1))) {
                    from--;
                }
            }
            if (found[1] === end - start) {
                while (to < text.length && isSpace(text.charAt(to))) {
                    to++;
                }
            }
            return {
                address: text.slice(start + found[0], start + found[1]),
                rest: text.slice(0, from) + ' ' + text.slice(to)
            };
        }
        start = end;
    }
    return null;
}
/**
 * The first `local@domain` of a word without white space, as `[start, end]`
 *
 * @param {String} word Text without white space
 * @return {Array|null} Offsets
 */
function findInWord(word) {
    const boundary = (index) => (index > 0 && isWord(word.charAt(index - 1))) !== (index < word.length && isWord(word.charAt(index)));
    let previous = -1;
    for (let at = word.indexOf('@'); at >= 0; at = word.indexOf('@', at + 1)) {
        const next = word.indexOf('@', at + 1);
        const limit = next < 0 ? word.length : next;
        let from = -1;
        for (let i = previous + 1; i < at; i++) {
            if (boundary(i)) {
                from = i;
                break;
            }
        }
        let to = -1;
        if (from >= 0) {
            for (let i = limit; i > at + 1; i--) {
                if (boundary(i)) {
                    to = i;
                    break;
                }
            }
        }
        if (from >= 0 && to >= 0) {
            return [from, to];
        }
        previous = at;
    }
    return null;
}
/**
 * Converts tokens for a single address into an address object
 *
 * @param {Array} tokens Tokens object
 * @param {Boolean} [inGroup] If true, the tokens are a member of a group. Groups do not nest
 *        (RFC 5322 3.4), so a colon is not a group separator here
 * @return {Object} Address object
 */
function _handleAddress(tokens, inGroup) {
    let token;
    let isGroup = false;
    let state = 'text';
    const addresses = [];
    const data = {
        address: [],
        comment: [],
        group: [],
        text: []
    };
    let i;
    let len;
    // Filter out <addresses>, (comments) and regular text
    for (i = 0, len = tokens.length; i < len; i++) {
        token = tokens[i];
        if (token.type === 'operator') {
            switch (token.value) {
                case '<':
                    state = 'address';
                    break;
                case '(':
                    state = 'comment';
                    break;
                case ':':
                    if (inGroup) {
                        state = 'text';
                        break;
                    }
                    state = 'group';
                    isGroup = true;
                    break;
                default:
                    state = 'text';
            }
        }
        else {
            if (token.value) {
                data[state].push(token.value);
            }
        }
    }
    // If there is no text but a comment, replace the two
    if (!data.text.length && data.comment.length) {
        data.text = data.comment;
        data.comment = [];
    }
    if (isGroup) {
        // http://tools.ietf.org/html/rfc2822#appendix-A.1.3
        const text = data.text.join(' ');
        addresses.push({
            // RFC 5322 section 3.4 requires a display name, but a group like ":a@b;" still parses, with an empty name
            name: text,
            group: data.group.length ? parse(data.group.join(','), true) : []
        });
    }
    else {
        // If no address was found, try to detect one from regular text
        if (!data.address.length && data.text.length) {
            for (i = data.text.length - 1; i >= 0; i--) {
                if (data.text[i].match(/^[^@\s]+@[^@\s]+$/)) {
                    data.address = data.text.splice(i, 1);
                    break;
                }
            }
            // still no address: the first word of the text that holds an address, in one pass over each element
            for (i = data.text.length - 1; i >= 0 && !data.address.length; i--) {
                const found = findAddress(data.text[i]);
                if (found) {
                    data.address = [found.address];
                    data.text[i] = found.rest.trim();
                    break;
                }
                data.text[i] = data.text[i].trim();
            }
        }
        // If there's still is no text but a comment exixts, replace the two
        if (!data.text.length && data.comment.length) {
            data.text = data.comment;
            data.comment = [];
        }
        // Keep only the first address occurence, push others to regular text
        if (data.address.length > 1) {
            data.text = data.text.concat(data.address.splice(1));
        }
        // Join values with spaces
        const text = data.text.join(' ');
        const addressText = data.address.join(' ');
        const address = {
            address: addressText || text || '',
            name: text || addressText || ''
        };
        if (address.address === address.name) {
            if ((address.address || '').match(/@/)) {
                address.name = '';
            }
            else {
                address.address = '';
            }
        }
        addresses.push(address);
    }
    return addresses;
}
/**
 * Creates a Tokenizer object for tokenizing address field strings
 *
 * @constructor
 * @param {String} str Address field string
 */
class Tokenizer {
    constructor(str) {
        this.str = (str || '').toString();
        this.operatorCurrent = '';
        this.operatorExpecting = '';
        this.node = null;
        this.escaped = false;
        this.list = [];
    }
    /**
     * Tokenizes the original input string
     *
     * @return {Array} An array of operator|text tokens
     */
    tokenize() {
        let chr;
        const list = [];
        for (let i = 0, len = this.str.length; i < len; i++) {
            chr = this.str.charAt(i);
            this.checkChar(chr);
        }
        this.list.forEach(node => {
            node.value = (node.value || '').toString().trim();
            if (node.value) {
                list.push(node);
            }
        });
        return list;
    }
    /**
     * Checks if a character is an operator or text and acts accordingly
     *
     * @param {String} chr Character from the address field
     */
    checkChar(chr) {
        if ((chr in this.operators || chr === '\\') && this.escaped) {
            this.escaped = false;
        }
        else if (this.operatorExpecting && chr === this.operatorExpecting) {
            this.node = {
                type: 'operator',
                value: chr
            };
            this.list.push(this.node);
            this.node = null;
            this.operatorExpecting = '';
            this.escaped = false;
            return;
        }
        else if (!this.operatorExpecting && chr in this.operators) {
            this.node = {
                type: 'operator',
                value: chr
            };
            this.list.push(this.node);
            this.node = null;
            this.operatorExpecting = this.operators[chr];
            this.escaped = false;
            return;
        }
        if (!this.escaped && chr === '\\') {
            this.escaped = true;
            return;
        }
        if (!this.node) {
            this.node = {
                type: 'text',
                value: ''
            };
            this.list.push(this.node);
        }
        if (this.escaped && chr !== '\\') {
            this.node.value += '\\';
        }
        this.node.value += chr;
        this.escaped = false;
    }
}
/**
 * Operator tokens and which tokens are expected to end the sequence
 */
Tokenizer.prototype.operators = {
    '"': '"',
    '(': ')',
    '<': '>',
    ',': '',
    ':': ';'
};
