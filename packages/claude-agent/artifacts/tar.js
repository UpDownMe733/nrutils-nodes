/**
 * Copyright 2026 UpDownMe733
 * Licensed under the Apache License, Version 2.0
 * http://www.apache.org/licenses/LICENSE-2.0
 */

'use strict';

// A small reader for the tar format that `tar -cf -` writes (ustar, pax and GNU long names).
// It accepts regular files and folders only. It does not trust the archive: each other entry type
// and each unsafe name stops the read with an error.

const BLOCK = 512;
const META_LIMIT = 1024 * 1024;

function fail(message, limit) {
    const err = new Error(message);
    if (limit) err.limit = limit;
    return err;
}

// A text field ends at the first NUL byte.
function text(h, offset, length) {
    const part = h.subarray(offset, offset + length);
    const end = part.indexOf(0);
    return part.subarray(0, end < 0 ? length : end).toString('utf8');
}

// A number field: octal text, or base 256 when the first bit is set (GNU).
function number(h, offset, length) {
    if (h[offset] & 0x80) {
        let n = h[offset] & 0x7f;
        for (let i = 1; i < length; i++) n = n * 256 + h[offset + i];
        return n;
    }
    const s = text(h, offset, length).trim();
    if (!/^[0-7]*$/.test(s)) throw fail('the tar header is not valid');
    return s ? parseInt(s, 8) : 0;
}

function checksum(h) {
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : h[i];
    return sum;
}

// The records of a pax header: "<length> <key>=<value>\n". Gives a Map.
function pax(data) {
    const map = new Map();
    let i = 0;
    while (i < data.length) {
        const space = data.indexOf(0x20, i);
        const len = parseInt(data.subarray(i, space).toString(), 10);
        if (space < 0 || !(len > 0) || i + len > data.length) throw fail('the tar header is not valid');
        const record = data.subarray(space + 1, i + len - 1).toString('utf8');
        const eq = record.indexOf('=');
        if (eq > 0) map.set(record.slice(0, eq), record.slice(eq + 1));
        i += len;
    }
    return map;
}

// A name in the archive: relative, with no ".." part and no NUL byte. Gives the clean name.
function cleanName(name) {
    if (!name || name.includes('\0') || name.startsWith('/')) throw fail(`the name "${name}" is not allowed`);
    const parts = name.split('/').filter((p) => p && p !== '.');
    if (!parts.length || parts.includes('..')) throw fail(`the name "${name}" is not allowed`);
    return parts.join('/');
}

// Make a reader. write(chunk) takes the stream, end() finishes it and gives the files: [{ path, data }].
// A folder entry gives no file. limits: { maxBytes, maxFiles }. The error of a limit has err.limit = 'bytes' or 'files'.
// The result also has `folder`: true when the archive has a folder entry.
function tarReader({ maxBytes, maxFiles }) {
    let buf = Buffer.alloc(0);
    let state = 'header';       // header, body, pad
    let entry = null;           // { type, name, size } of the entry that the body belongs to
    let chunks = [];
    let remaining = 0;
    let pad = 0;
    let zeros = 0;
    let done = false;
    let total = 0;
    let count = 0;
    let next = {};              // pax and GNU fields for the next entry
    const files = [];
    let folder = false;

    function header(h) {
        if (checksum(h) !== number(h, 148, 8)) throw fail('the tar header is not valid');
        const type = String.fromCharCode(h[156] || 48);
        let name = text(h, 0, 100);
        if (text(h, 257, 5) === 'ustar') {
            const prefix = text(h, 345, 155);
            if (prefix) name = prefix + '/' + name;
        }
        let size = number(h, 124, 12);
        if (type === 'x' || type === 'g' || type === 'L') {
            if (size > META_LIMIT) throw fail('the tar header is not valid');
            return { type, name, size };
        }
        if (type !== '0' && type !== '5') throw fail(`the entry "${name}" is not a plain file or a folder`);
        if (next.size !== undefined) size = next.size;
        if (next.name !== undefined) name = next.name;
        next = {};
        count++;
        if (count > maxFiles) throw fail(`more than ${maxFiles} files`, 'files');
        if (type === '5') size = 0;
        total += size;
        if (total > maxBytes) throw fail('too large', 'bytes');
        return { type, name, size };
    }

    function finish() {
        const data = Buffer.concat(chunks);
        chunks = [];
        if (entry.type === 'x') {
            const map = pax(data);
            if (map.has('path')) next.name = map.get('path');
            if (map.has('size')) {
                const n = Number(map.get('size'));
                if (!Number.isSafeInteger(n) || n < 0) throw fail('the tar header is not valid');
                next.size = n;
            }
        } else if (entry.type === 'L') {
            next.name = text(data, 0, data.length);
        } else if (entry.type !== 'g') {
            const name = cleanName(entry.name);
            if (entry.type === '5') folder = true;
            else files.push({ path: name, data });
        }
    }

    function write(chunk) {
        buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
        while (!done) {
            if (state === 'header') {
                if (buf.length < BLOCK) break;
                const h = buf.subarray(0, BLOCK);
                buf = buf.subarray(BLOCK);
                if (h.every((b) => b === 0)) {
                    if (++zeros >= 2) done = true;
                    continue;
                }
                zeros = 0;
                entry = header(h);
                remaining = entry.size;
                pad = (BLOCK - (remaining % BLOCK)) % BLOCK;
                state = 'body';
            }
            if (state === 'body') {
                const n = Math.min(remaining, buf.length);
                if (n) {
                    chunks.push(buf.subarray(0, n));
                    buf = buf.subarray(n);
                    remaining -= n;
                }
                if (remaining) break;
                finish();
                state = 'pad';
            }
            if (state === 'pad') {
                const n = Math.min(pad, buf.length);
                buf = buf.subarray(n);
                pad -= n;
                if (pad) break;
                state = 'header';
            }
        }
        if (done) buf = Buffer.alloc(0);
    }

    function end() {
        if (!done && (state !== 'header' || buf.length)) throw fail('the tar stream is not complete');
        return { files, folder };
    }

    return { write, end };
}

module.exports = { tarReader };
