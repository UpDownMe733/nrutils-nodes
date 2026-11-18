/**
 * Copyright 2026 UpDownMe733
 * Licensed under the Apache License, Version 2.0
 * http://www.apache.org/licenses/LICENSE-2.0
 */

'use strict';

// The view server of the artifacts (docs/artifacts.md, sections 5 and 6).
// It is its own http.Server on its own port, with no Express app of Node-RED: a port is a part of the origin,
// so content of an agent cannot read the editor. It only reads the store. It has no route that changes data.
//
// Routes (GET and HEAD only):
//   /v/<ticket>/            the viewer page (a new nonce for each response)
//   /v/<ticket>/meta        the version as JSON: title, time, entry and the file list
//   /v/<ticket>/f/<path>    one file of the version, found by an exact match of its path in the file list
//   /v/<ticket>/download    the file, or a zip of all files of the version
//   /viewer/<asset>         the scripts and the style of the viewer page (a fixed list)
//
// The store (store.js) gives: key, record(id), version(id, n) and blobPath(sha256).

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const zlib = require('zlib');
const crypto = require('crypto');
const ticket = require('./ticket');

const VIEWER_DIR = path.join(__dirname, '..', 'viewer');

// The CSP of each artifact file. The file gets an opaque origin: no allow-same-origin, no allow-top-navigation.
const SANDBOX = 'sandbox allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads';
function fileCsp(htmlNetwork, ancestors) {
    return SANDBOX + "; default-src 'self' data: blob: 'unsafe-inline' 'unsafe-eval'" + (htmlNetwork ? ' https:' : '') +
        '; frame-ancestors ' + ancestors;
}

// An origin that frame-ancestors can hold: a scheme, a plain host and a port, with no path
const ORIGIN = /^https?:\/\/([A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])(:[0-9]{1,5})?$/;

// ---- The zip writer (store or deflate, UTF-8 names, no zip64: a publish is 100 MB and 2000 files at most)

const CRC_TABLE = new Int32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    return c;
});

function tableCrc32(buf) {
    let c = -1;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
}

// zlib.crc32 is in Node.js 20.15 and later. The table is for an older Node.js.
const crc32 = zlib.crc32 ? (buf) => zlib.crc32(buf) : tableCrc32;

// A name in a zip must be relative, with "/" only and no "." or ".." segment: an unzip program must not write outside its folder.
function zipNameError(name, seen) {
    if (!name || name.startsWith('/') || /[\\\u0000-\u001f\u007f]/.test(name)) return true;
    if (name.split('/').some(s => s === '' || s === '.' || s === '..')) return true;
    return seen.has(name);
}

function dosTime(ms) {
    const d = new Date(ms);
    const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const date = (Math.max(d.getFullYear() - 1980, 0) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    return { time, date };
}

// Writes the zip to the stream out. files: [{ path, read() }]. Gives a promise.
// A bad or a duplicate name stops the zip before the first byte.
async function writeZip(out, files, ms) {
    const seen = new Set();
    for (const f of files) {
        if (zipNameError(f.path, seen)) throw new Error('the zip cannot hold the name ' + JSON.stringify(f.path));
        seen.add(f.path);
    }
    const { time, date } = dosTime(ms);
    const central = [];
    let offset = 0;
    // Waits for "drain" when the buffer of the stream is full. A closed stream stops the zip.
    const write = async (buf) => {
        if (out.destroyed) throw new Error('the stream is closed');
        offset += buf.length;
        if (out.write(buf)) return;
        await new Promise(resolve => {
            const done = () => { out.off('drain', done); out.off('close', done); resolve(); };
            out.on('drain', done);
            out.on('close', done);
        });
    };
    for (const f of files) {
        const data = await f.read();
        const name = Buffer.from(f.path);
        const crc = crc32(data);
        let body = await new Promise((res, rej) => zlib.deflateRaw(data, (e, b) => e ? rej(e) : res(b)));
        let method = 8;
        if (body.length >= data.length) { body = data; method = 0; }
        const head = Buffer.alloc(30);
        head.writeUInt32LE(0x04034b50, 0);
        head.writeUInt16LE(20, 4);
        head.writeUInt16LE(0x0800, 6);
        head.writeUInt16LE(method, 8);
        head.writeUInt16LE(time, 10);
        head.writeUInt16LE(date, 12);
        head.writeUInt32LE(crc, 14);
        head.writeUInt32LE(body.length, 18);
        head.writeUInt32LE(data.length, 22);
        head.writeUInt16LE(name.length, 26);
        const dir = Buffer.alloc(46);
        dir.writeUInt32LE(0x02014b50, 0);
        dir.writeUInt16LE(20, 4);
        head.copy(dir, 6, 4, 30);
        dir.writeUInt32LE(offset, 42);
        central.push(dir, name);
        await write(head);
        await write(name);
        await write(body);
    }
    const start = offset;
    const dirBuf = Buffer.concat(central);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(files.length, 8);
    end.writeUInt16LE(files.length, 10);
    end.writeUInt32LE(dirBuf.length, 12);
    end.writeUInt32LE(start, 16);
    await write(dirBuf);
    await write(end);
}

// ---- The server

const ASSET_TYPES = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

// The path of a file in a dependency. The "exports" fields of marked and dompurify block
// require.resolve() of these files, thus find the package folder in the module search paths.
function packageFile(name, file) {
    for (const dir of require.resolve.paths(name)) {
        const p = path.join(dir, name, file);
        if (fs.existsSync(p)) return p;
    }
    throw new Error('the file ' + file + ' of the package ' + name + ' is missing');
}

// The fixed list of the files that /viewer/ serves: the viewer files and the two libraries
function assetList() {
    const list = {
        'lib/marked.js': packageFile('marked', 'lib/marked.umd.js'),
        'lib/purify.js': packageFile('dompurify', 'dist/purify.min.js')
    };
    for (const name of fs.readdirSync(VIEWER_DIR)) {
        if (ASSET_TYPES[path.extname(name)]) list[name] = path.join(VIEWER_DIR, name);
    }
    for (const name of fs.readdirSync(path.join(VIEWER_DIR, 'renderers'))) {
        if (name.endsWith('.js')) list['renderers/' + name] = path.join(VIEWER_DIR, 'renderers', name);
    }
    return list;
}

const DEAD = '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">' +
    '<title>File</title></head><body style="font-family:sans-serif;padding:16px">This link does not work.</body></html>';

// The file name of a download: "<title>-v3.<ext>". Characters that a file system does not accept become "_".
function downloadName(version, ext) {
    let title = String(version.title || 'file').replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '_').trim().slice(0, 100) || 'file';
    if (ext && title.toLowerCase().endsWith(ext.toLowerCase())) title = title.slice(0, -ext.length) || 'file';
    return title + '-v' + version.n + ext;
}

function disposition(name) {
    const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
    return 'attachment; filename="' + ascii + '"; filename*=UTF-8\'\'' + encodeURIComponent(name);
}

// Makes the request handler. opts: { store, htmlNetwork, editorOrigins, uiPort }
// editorOrigins: an iterable of the origins of the editor, read on each request. uiPort: the editor port for a guess.
function handler(opts) {
    const { store } = opts;
    let zipping = false;
    const assets = assetList();
    const page = fs.readFileSync(path.join(VIEWER_DIR, 'index.html'), 'utf8');

    function send(res, code, type, body) {
        res.writeHead(code, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(body) });
        res.end(res.req.method === 'HEAD' ? undefined : body);
    }

    function notFound(res, html) {
        if (html) send(res, 404, 'text/html; charset=utf-8', DEAD);
        else send(res, 404, 'text/plain; charset=utf-8', 'Not found');
    }

    // The version of a valid ticket, when it is not deleted or purged
    function lookup(text) {
        const t = ticket.verify(store.key, text);
        const version = t && store.version(t.id, t.n);
        return version ? { record: store.record(t.id), version } : null;
    }

    // The editor may put the viewer page and its files in a frame. Its origins come from the ticket requests.
    // With no known origin, the guess is the host of this request with the editor port.
    function frameAncestors(req) {
        const known = [...(opts.editorOrigins || [])].filter(o => typeof o === 'string' && ORIGIN.test(o));
        if (known.length) return ["'self'", ...new Set(known)].join(' ');
        const host = String(req.headers.host || '').replace(/:[0-9]+$/, '');
        if (!/^([A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])$/.test(host)) return "'self'";
        const port = ':' + (opts.uiPort || 1880);
        return "'self' http://" + host + port + ' https://' + host + port;
    }

    function viewerPage(res, query, ancestors) {
        const nonce = crypto.randomBytes(16).toString('base64');
        const theme = /^(light|dark)$/.test(query.get('theme') || '') ? query.get('theme') : '';
        res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'nonce-" + nonce + "'; " +
            "style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; object-src 'none'; base-uri 'none'; " +
            "form-action 'none'; frame-ancestors " + ancestors);
        send(res, 200, 'text/html; charset=utf-8', page.replace(/\{\{nonce\}\}/g, nonce).replace('{{theme}}', theme));
    }

    function meta(res, record, version) {
        const newest = record.versions.filter(v => !v.deleted && !v.purged).pop();
        send(res, 200, 'application/json; charset=utf-8', JSON.stringify({
            id: record.id, name: record.name, n: version.n, newest: !!newest && newest.n === version.n,
            title: version.title, time: version.time, note: version.note, entry: version.entry,
            files: version.files.map(f => ({ path: f.path, size: f.size, type: f.type, sha256: f.sha256 }))
        }));
    }

    // A file as PDF only when its type is application/pdf and its first bytes are "%PDF-" (no sandbox CSP for it)
    async function isPdf(file, blob) {
        if (file.type !== 'application/pdf') return false;
        const fd = await fs.promises.open(blob, 'r');
        try {
            const buf = Buffer.alloc(5);
            await fd.read(buf, 0, 5, 0);
            return buf.toString('latin1') === '%PDF-';
        } finally {
            await fd.close();
        }
    }

    async function serveFile(req, res, file, ancestors) {
        const blob = store.blobPath(file.sha256);
        const stat = await fs.promises.stat(blob);
        let type = file.type || 'application/octet-stream';
        if (await isPdf(file, blob)) {
            // Chrome shows no PDF in a sandboxed document. The PDF viewer of the browser runs no script of the file.
            res.setHeader('Content-Security-Policy', 'frame-ancestors ' + ancestors);
        } else {
            if (type === 'application/pdf') type = 'application/octet-stream';
            if (/^text\//.test(type)) type += '; charset=utf-8';
        }
        res.setHeader('Content-Type', type);
        res.setHeader('Accept-Ranges', 'bytes');
        let start = 0, end = stat.size - 1;
        // A request for more than one range gets the full file: a multipart response is not necessary for a viewer.
        const range = req.headers.range;
        if (range && !range.includes(',')) {
            const m = /^bytes=([0-9]*)-([0-9]*)$/.exec(range);
            if (m && (m[1] || m[2])) {
                if (m[1]) { start = Number(m[1]); if (m[2]) end = Math.min(Number(m[2]), end); }
                else start = Math.max(stat.size - Number(m[2]), 0);
            }
            if (!m || !(m[1] || m[2]) || start > end) {
                res.writeHead(416, { 'Content-Range': 'bytes */' + stat.size });
                return res.end();
            }
            res.statusCode = 206;
            res.setHeader('Content-Range', 'bytes ' + start + '-' + end + '/' + stat.size);
        }
        res.setHeader('Content-Length', end - start + 1);
        if (req.method === 'HEAD' || stat.size === 0) return res.end();
        fs.createReadStream(blob, { start, end }).on('error', () => res.destroy()).pipe(res);
    }

    async function download(req, res, version) {
        res.setHeader('Content-Type', 'application/octet-stream');
        if (version.files.length === 1) {
            const file = version.files[0];
            res.setHeader('Content-Disposition', disposition(downloadName(version, path.extname(file.path))));
            const blob = store.blobPath(file.sha256);
            const stat = await fs.promises.stat(blob);
            res.setHeader('Content-Length', stat.size);
            if (req.method === 'HEAD' || stat.size === 0) return res.end();
            return fs.createReadStream(blob).on('error', () => res.destroy()).pipe(res);
        }
        // One zip at a time: a zip reads each file into memory.
        if (zipping) {
            res.setHeader('Retry-After', '5');
            return send(res, 503, 'text/plain; charset=utf-8', 'An other download is in progress. Try again soon.');
        }
        res.setHeader('Content-Disposition', disposition(downloadName(version, '.zip')));
        if (req.method === 'HEAD') return res.end();
        const files = version.files.map(f => ({ path: f.path, read: () => fs.promises.readFile(store.blobPath(f.sha256)) }));
        zipping = true;
        try {
            await writeZip(res, files, version.time);
        } finally {
            zipping = false;
        }
        res.end();
    }

    async function route(req, res) {
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Referrer-Policy', 'no-referrer');
        res.setHeader('Cache-Control', 'private, no-store');
        if (req.method !== 'GET' && req.method !== 'HEAD') {
            res.setHeader('Allow', 'GET, HEAD');
            return send(res, 405, 'text/plain; charset=utf-8', 'Method not allowed');
        }
        const url = new URL(req.url, 'http://x');
        // The raw path: new URL() removes "." and ".." segments, and the lookup must see the path as it was sent
        const p = req.url.split('?')[0];
        if (p.startsWith('/viewer/')) {
            const file = Object.prototype.hasOwnProperty.call(assets, p.slice(8)) && assets[p.slice(8)];
            if (!file) return notFound(res);
            return send(res, 200, ASSET_TYPES[path.extname(file)] || ASSET_TYPES['.js'], fs.readFileSync(file));
        }
        const m = /^\/v\/([^/]+)(\/(.*))?$/.exec(p);
        if (!m) return notFound(res);
        const found = lookup(m[1]);
        if (!found) return notFound(res, !m[3]);
        const { record, version } = found;
        const rest = m[3];
        if (rest === undefined) {
            res.writeHead(302, { Location: '/v/' + m[1] + '/' + url.search });
            return res.end();
        }
        const ancestors = frameAncestors(req);
        if (rest === '') return viewerPage(res, url.searchParams, ancestors);
        res.setHeader('Content-Security-Policy', fileCsp(opts.htmlNetwork, ancestors));
        if (rest === 'meta') return meta(res, record, version);
        if (rest === 'download') return download(req, res, version);
        if (rest.startsWith('f/')) {
            let want;
            try { want = rest.slice(2).split('/').map(decodeURIComponent).join('/'); } catch { return notFound(res); }
            const file = version.files.find(f => f.path === want);
            if (!file) return notFound(res);
            return serveFile(req, res, file, ancestors);
        }
        return notFound(res);
    }

    return (req, res) => {
        route(req, res).catch(() => {
            if (!res.headersSent) notFound(res);
            else res.destroy();
        });
    };
}

// ---- Start

// Starts the view server. settings: the artifacts settings (htmlNetwork). tls: the https options of the editor, or none:
// a page on HTTPS cannot show a frame on HTTP. uiPort: the editor port for the frame-ancestors guess.
// Gives a promise of { port, close() }. The promise rejects when the port cannot be opened.
function start({ store, port, bind, settings = {}, editorOrigins, tls, uiPort }) {
    const handle = handler({ store, htmlNetwork: settings.htmlNetwork !== false, editorOrigins, uiPort });
    const server = tls ? https.createServer(tls, handle) : http.createServer(handle);
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, bind || undefined, () => {
            server.off('error', reject);
            resolve({
                port: server.address().port,
                close: () => new Promise(done => { server.closeAllConnections(); server.close(() => done()); })
            });
        });
    });
}

module.exports = { start, handler, writeZip, crc32, downloadName };
