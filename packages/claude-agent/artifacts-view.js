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
// The store object gives: record(id), blobPath(sha256) and key (a Buffer).

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const zlib = require('zlib');
const crypto = require('crypto');

const TICKET_MS = 12 * 60 * 60 * 1000;
const VIEWER_DIR = path.join(__dirname, 'viewer');

// The CSP of each artifact file. The file gets an opaque origin: no allow-same-origin, no allow-top-navigation.
const SANDBOX = 'sandbox allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads';
function fileCsp(htmlNetwork) {
    return SANDBOX + "; default-src 'self' data: blob: 'unsafe-inline' 'unsafe-eval'" + (htmlNetwork ? ' https:' : '');
}

// ---- Tickets: base64url("id|n|expiry") + "." + base64url(HMAC-SHA256(key, "id|n|expiry"))

function mac(key, body) {
    return crypto.createHmac('sha256', key).update(body).digest('base64url');
}

function makeTicket(key, id, n, now = Date.now()) {
    const body = id + '|' + n + '|' + (now + TICKET_MS);
    return Buffer.from(body).toString('base64url') + '.' + mac(key, body);
}

// Gives { id, n } for a valid ticket that has not expired, else null
function readTicket(key, ticket, now = Date.now()) {
    const m = /^([A-Za-z0-9_-]{1,100})\.([A-Za-z0-9_-]{43})$/.exec(ticket || '');
    if (!m) return null;
    const body = Buffer.from(m[1], 'base64url').toString();
    const want = Buffer.from(mac(key, body));
    const got = Buffer.from(m[2]);
    if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
    const p = /^([0-9a-f]{16})\|([1-9][0-9]{0,8})\|([0-9]{1,15})$/.exec(body);
    if (!p || Number(p[3]) < now) return null;
    return { id: p[1], n: Number(p[2]) };
}

// The URL of the view server for the browser of the editor. req is the request of the admin API.
function baseUrl(req, settings) {
    const a = (settings && settings.artifacts) || {};
    if (a.viewUrl) return String(a.viewUrl).replace(/\/+$/, '');
    let host = req.hostname || 'localhost';
    if (host.includes(':') && !host.startsWith('[')) host = '[' + host + ']';
    return req.protocol + '://' + host + ':' + (a.viewPort || 1881);
}

const IMAGE = /^image\/(png|jpeg|gif|webp|avif|bmp|x-icon|vnd\.microsoft\.icon|svg\+xml)$/;

// The URLs of one version: the viewer page, the download, and a thumbnail when the entry is an image
function urls(base, ticket, version) {
    const v = base + '/v/' + ticket + '/';
    const entry = version.files.find(f => f.path === version.entry);
    return {
        view: v,
        download: v + 'download',
        thumb: entry && IMAGE.test(entry.type) ? v + 'f/' + encodePath(entry.path) : null
    };
}

function encodePath(p) {
    return p.split('/').map(encodeURIComponent).join('/');
}

// ---- The zip writer (store or deflate, UTF-8 names, no zip64: a publish is 100 MB and 2000 files at most)

const CRC_TABLE = new Int32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    return c;
});

function crc32(buf) {
    let c = -1;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
}

function dosTime(ms) {
    const d = new Date(ms);
    const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const date = (Math.max(d.getFullYear() - 1980, 0) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    return { time, date };
}

// Writes the zip to the stream out. files: [{ path, data }]. Gives a promise.
async function writeZip(out, files, ms) {
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

// Makes the request handler. opts: { store, htmlNetwork, uiPort }
function handler(opts) {
    const { store } = opts;
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
    function lookup(ticket) {
        const t = readTicket(store.key, ticket);
        if (!t) return null;
        const record = store.record(t.id);
        if (!record || record.deleted) return null;
        const version = record.versions.find(v => v.n === t.n);
        if (!version || version.deleted || version.purged) return null;
        return { record, version };
    }

    // The editor may put the viewer page in a frame. Its origin is the host of this request with the editor port.
    function frameAncestors(req) {
        const host = String(req.headers.host || '').replace(/:[0-9]+$/, '');
        if (!/^([A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])$/.test(host)) return "'self'";
        const port = ':' + (opts.uiPort || 1880);
        return "'self' http://" + host + port + ' https://' + host + port;
    }

    function viewerPage(req, res, query) {
        const nonce = crypto.randomBytes(16).toString('base64');
        const theme = /^(light|dark)$/.test(query.get('theme') || '') ? query.get('theme') : '';
        res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'nonce-" + nonce + "'; " +
            "style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; object-src 'none'; base-uri 'none'; " +
            "form-action 'none'; frame-ancestors " + frameAncestors(req));
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

    async function serveFile(req, res, file) {
        const blob = store.blobPath(file.sha256);
        const stat = await fs.promises.stat(blob);
        let type = file.type || 'application/octet-stream';
        if (await isPdf(file, blob)) {
            res.removeHeader('Content-Security-Policy');
        } else {
            if (type === 'application/pdf') type = 'application/octet-stream';
            if (/^text\//.test(type)) type += '; charset=utf-8';
        }
        res.setHeader('Content-Type', type);
        res.setHeader('Accept-Ranges', 'bytes');
        let start = 0, end = stat.size - 1;
        const range = req.headers.range;
        if (range) {
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
        res.setHeader('Content-Disposition', disposition(downloadName(version, '.zip')));
        if (req.method === 'HEAD') return res.end();
        const files = version.files.map(f => ({ path: f.path, read: () => fs.promises.readFile(store.blobPath(f.sha256)) }));
        await writeZip(res, files, version.time);
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
        if (rest === '') return viewerPage(req, res, url.searchParams);
        res.setHeader('Content-Security-Policy', fileCsp(opts.htmlNetwork));
        if (rest === 'meta') return meta(res, record, version);
        if (rest === 'download') return download(req, res, version);
        if (rest.startsWith('f/')) {
            let want;
            try { want = rest.slice(2).split('/').map(decodeURIComponent).join('/'); } catch { return notFound(res); }
            const file = version.files.find(f => f.path === want);
            if (!file) return notFound(res);
            return serveFile(req, res, file);
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

// ---- One view server for each Node-RED process

let server = null;

// Starts the view server from RED.settings.claudeAgent.artifacts. No artifacts block or viewPort 0: no server.
async function start(RED, store) {
    if (server) return server;
    const a = (RED.settings.claudeAgent || {}).artifacts;
    const port = a ? (a.viewPort === undefined ? 1881 : a.viewPort) : 0;
    if (!port) return null;
    const handle = handler({ store, htmlNetwork: a.htmlNetwork !== false, uiPort: RED.settings.uiPort });
    // The view server uses HTTPS when the editor does: a page on HTTPS cannot show a frame on HTTP.
    let tls = RED.settings.https;
    if (typeof tls === 'function') tls = await tls();
    server = tls ? https.createServer(tls, handle) : http.createServer(handle);
    server.on('error', (err) => RED.log.error('claude-agent: the view server cannot start on port ' + port + ': ' + err.message));
    server.listen(port, RED.settings.uiHost || undefined);
    return server;
}

function stop() {
    if (!server) return Promise.resolve();
    const s = server;
    server = null;
    return new Promise(resolve => { s.closeAllConnections && s.closeAllConnections(); s.close(() => resolve()); });
}

module.exports = { makeTicket, readTicket, baseUrl, urls, handler, start, stop, writeZip, crc32, downloadName };
