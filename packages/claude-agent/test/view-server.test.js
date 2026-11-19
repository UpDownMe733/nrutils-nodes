'use strict';

// Checks the view server of the artifacts (artifacts/view-server.js) with a fake store in a temporary folder,
// and the match rules of the renderers of the viewer page in a small fake DOM.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const zlib = require('zlib');
const vm = require('vm');
const crypto = require('crypto');

const view = require('../artifacts/view-server.js');
const ticket = require('../artifacts/ticket.js');

const VIEWER = path.join(__dirname, '..', 'viewer');
const ID = '3f9c0e1a7b2d4c55';
const ID_IMG = '3f9c0e1a7b2d4c66';
const ID_HTML = '3f9c0e1a7b2d4c77';

// A fake store: the blobs in a temporary folder, the records in memory
function fakeStore(dir) {
    const blobs = path.join(dir, 'blobs');
    fs.mkdirSync(blobs, { recursive: true });
    const records = {};
    const key = crypto.randomBytes(32);
    function put(content) {
        const buf = Buffer.from(content);
        const sha = crypto.createHash('sha256').update(buf).digest('hex');
        fs.writeFileSync(path.join(blobs, sha), buf);
        return { sha256: sha, size: buf.length };
    }
    return {
        key, records, put,
        record: (id) => records[id] || null,
        version: (id, n) => {
            const r = records[id];
            const v = r && !r.deleted && r.versions.find(x => x.n === Number(n));
            return v && !v.deleted && !v.purged ? v : undefined;
        },
        blobPath: (sha) => path.join(blobs, sha)
    };
}

function file(store, p, type, content) {
    return Object.assign({ path: p, type }, store.put(content));
}

function get(port, p, headers = {}, method = 'GET') {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
        });
        req.on('error', reject);
        req.end();
    });
}

// Reads a zip with the local headers: [{ path, data }]
function unzip(buf) {
    const out = [];
    let i = 0;
    while (buf.readUInt32LE(i) === 0x04034b50) {
        const method = buf.readUInt16LE(i + 8);
        const crc = buf.readUInt32LE(i + 14);
        const csize = buf.readUInt32LE(i + 18);
        const nameLen = buf.readUInt16LE(i + 26);
        const extra = buf.readUInt16LE(i + 28);
        const name = buf.subarray(i + 30, i + 30 + nameLen).toString();
        const body = buf.subarray(i + 30 + nameLen + extra, i + 30 + nameLen + extra + csize);
        const data = method === 8 ? zlib.inflateRawSync(body) : Buffer.from(body);
        assert.equal(view.crc32(data), crc, 'the CRC of ' + name);
        out.push({ path: name, data });
        i += 30 + nameLen + extra + csize;
    }
    const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    assert.equal(buf.readUInt16LE(end + 10), out.length, 'the count in the end record');
    return out;
}

describe('the helpers', () => {
    it('makes the download name from the title and the version', () => {
        assert.equal(view.downloadName({ title: 'Load test: report', n: 3 }, '.md'), 'Load test_ report-v3.md');
        assert.equal(view.downloadName({ title: 'notes.md', n: 1 }, '.md'), 'notes-v1.md');
        assert.equal(view.downloadName({ title: '', n: 2 }, '.zip'), 'file-v2.zip');
    });

    it('refuses a zip name that can write outside the folder of the unzip, and a duplicate', async () => {
        const out = { write: () => true, destroyed: false };
        const read = async () => Buffer.from('x');
        for (const name of ['/etc/x', 'a\\b', '../x', 'a/../b', 'a//b', './a', 'a/', 'a\u0001b', '']) {
            await assert.rejects(view.writeZip(out, [{ path: name, read }], 0), /cannot hold/, JSON.stringify(name));
        }
        await assert.rejects(view.writeZip(out, [{ path: 'a', read }, { path: 'a', read }], 0), /cannot hold/);
        await view.writeZip(out, [{ path: 'a/b..c', read }, { path: 'ü .md', read }], 0);
    });

    it('closes the stream of a zip client that reads no more, so the zip lock is free again', async () => {
        const out = new (require('events'))();
        Object.assign(out, { destroyed: false, write: () => false, destroy() { this.destroyed = true; this.emit('close'); } });
        await assert.rejects(view.writeZip(out, [{ path: 'a', read: async () => Buffer.from('x') }], 0, 20), /closed/);
        assert.equal(out.destroyed, true);
    });
});

describe('meta of each server', () => {
    const record = { id: 'abc', name: 'r', owner: { address: 't/a', nodeId: 'n1' }, versions: [] };
    const version = { n: 1, time: 1, title: 'T', note: 'internal', entry: 'a.md', run: 'x', files: [{ path: 'a.md', size: 1, type: 'text/markdown', sha256: 'f', blob: '/x' }] };
    record.versions.push(version);

    it('gives the share server only the keys of its allow list: no note, no owner, no editor, no id', () => {
        const m = view.metaOf('share', record, version, { editor: 'http://e/#files/abc/1' });
        assert.deepEqual(Object.keys(m).sort(), ['entry', 'files', 'n', 'name', 'newest', 'time', 'title']);
        assert.deepEqual(Object.keys(m.files[0]).sort(), ['path', 'sha256', 'size', 'type']);
    });

    it('gives the view server the owner and the editor URL', () => {
        const m = view.metaOf('view', record, version, { editor: 'http://e/#files/abc/1' });
        assert.equal(m.owner, 't/a');
        assert.equal(m.editor, 'http://e/#files/abc/1');
        assert.equal(m.note, 'internal');
        assert.equal(m.run, undefined);
    });
});

describe('the editor path', () => {
    const { adminRoot } = require('../artifacts');
    it('ends with "/" and is none when the editor is off', () => {
        assert.equal(adminRoot(undefined), '/');
        assert.equal(adminRoot('/'), '/');
        assert.equal(adminRoot('/admin'), '/admin/');
        assert.equal(adminRoot('admin/'), '/admin/');
        assert.equal(adminRoot(false), undefined);
    });
});

describe('the view server', () => {
    let dir, store, server, port, t1, t2, tDel;
    const origins = new Set();

    before(async () => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'view-server-'));
        store = fakeStore(dir);
        fs.writeFileSync(path.join(dir, 'secret.txt'), 'secret');
        const v1 = {
            n: 1, time: Date.UTC(2026, 10, 18, 14, 2), title: 'Report', note: '', entry: 'report.md', deleted: null, purged: false,
            files: [file(store, 'report.md', 'text/markdown', '# Report\n\nHello ü\n')]
        };
        const v2 = {
            n: 2, time: Date.UTC(2026, 10, 18, 15, 0), title: 'Report', note: 'more', entry: 'index.html', deleted: null, purged: false,
            files: [
                file(store, 'index.html', 'text/html', '<h1>Hi</h1><script>1</script>'),
                file(store, 'img/a b.png', 'image/png', Buffer.from('89504e47', 'hex')),
                file(store, 'doc.pdf', 'application/pdf', '%PDF-1.4 real'),
                file(store, 'fake.pdf', 'application/pdf', '<html><script>alert(1)</script>'),
                file(store, 'big.txt', 'text/plain', 'x'.repeat(5000) + 'abc'.repeat(2000)),
                file(store, 'empty.bin', 'application/octet-stream', '')
            ]
        };
        const v3 = { n: 3, time: Date.now(), title: 'Report', entry: 'a.md', deleted: Date.now(), purged: false, files: [] };
        store.records[ID] = { id: ID, name: 'report', owner: { address: 't/a', nodeId: 'n1' }, versions: [v1, v2, v3] };
        t1 = ticket.make(store.key, ID, 1);
        t2 = ticket.make(store.key, ID, 2);
        tDel = ticket.make(store.key, ID, 3);
        const img = Buffer.from('89504e47', 'hex');
        store.records[ID_IMG] = { id: ID_IMG, name: 'chart', owner: { address: 't/a', nodeId: 'n1' }, versions: [
            { n: 1, time: Date.now(), title: 'Chart', entry: 'c.png', deleted: null, purged: false, files: [file(store, 'c.png', 'image/png', img)] },
            { n: 2, time: Date.now(), title: 'Chart', entry: 'c.png', deleted: null, purged: false, files: [file(store, 'c.png', 'image/png', Buffer.alloc(1024 * 1024 + 1))] }] };
        store.records[ID_HTML] = { id: ID_HTML, name: 'one', owner: { address: 't/a', nodeId: 'n1' }, versions: [
            { n: 1, time: Date.now(), title: 'One', entry: 'one.html', deleted: null, purged: false, files: [file(store, 'one.html', 'text/html', '<p>one</p>')] }] };
        server = http.createServer(view.handler({ store, htmlNetwork: true, uiPort: 1880, editorOrigins: origins, adminRoot: '/admin/' }));
        await new Promise(r => server.listen(0, '127.0.0.1', r));
        port = server.address().port;
    });

    after(() => {
        server.close();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('sends the strict headers on each response', async () => {
        for (const p of ['/v/' + t1 + '/', '/v/' + t1 + '/meta', '/v/' + t1 + '/f/report.md', '/viewer/viewer.js', '/nothing']) {
            const r = await get(port, p);
            assert.equal(r.headers['x-content-type-options'], 'nosniff', p);
            assert.equal(r.headers['referrer-policy'], 'no-referrer', p);
            assert.equal(r.headers['cache-control'], 'private, no-store', p);
        }
    });

    it('serves the viewer page with a new nonce on each script, and a strict CSP', async () => {
        const a = await get(port, '/v/' + t1 + '/?theme=dark', { host: 'nr.lan:1881' });
        const b = await get(port, '/v/' + t1 + '/');
        assert.equal(a.status, 200);
        const csp = a.headers['content-security-policy'];
        const nonce = /script-src 'nonce-([^']+)'/.exec(csp)[1];
        assert.notEqual(nonce, /script-src 'nonce-([^']+)'/.exec(b.headers['content-security-policy'])[1]);
        assert.match(csp, /^default-src 'self'; /);
        assert.match(csp, /object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self' http:\/\/nr\.lan:1880 https:\/\/nr\.lan:1880$/);
        const html = a.body.toString();
        const scripts = html.match(/<script[^>]*>/g);
        assert.ok(scripts.length >= 8);
        for (const s of scripts) assert.ok(s.includes('nonce="' + nonce + '"'), s);
        assert.match(html, /<html lang="en" data-theme="dark">/);
        assert.doesNotMatch(b.body.toString(), /\{\{/);
    });

    it('hides the top bar only for embed=1, and keeps the title, the version and Download', async () => {
        const bar = async (q) => /<header class="bar"( hidden)?>/.exec((await get(port, '/v/' + t1 + '/' + q)).body.toString())[1];
        assert.equal(await bar('?embed=1'), ' hidden');
        assert.equal(await bar(''), undefined);
        assert.equal(await bar('?embed=0'), undefined);
        const html = (await get(port, '/v/' + t1 + '/')).body.toString();
        for (const id of ['title', 'version', 'download', 'note', 'files-toggle']) assert.ok(html.includes('id="' + id + '"'), id);
    });

    it('has no Close button, because window.close() does nothing on a share link', () => {
        assert.doesNotMatch(fs.readFileSync(path.join(VIEWER, 'index.html'), 'utf8'), /id="close"|>Close</);
        assert.doesNotMatch(fs.readFileSync(path.join(VIEWER, 'viewer.js'), 'utf8'), /window\.close|window\.top/);
    });

    it('accepts only a plain host name in frame-ancestors', async () => {
        const r = await get(port, '/v/' + t1 + '/', { host: "x; script-src *" });
        assert.match(r.headers['content-security-policy'], /frame-ancestors 'self'$/);
    });

    it('uses the known editor origins in frame-ancestors of the page and of each file, and ignores a bad origin', async () => {
        origins.add('https://nr.lan:1880').add("http://x; script-src *").add('http://[::1]:1880').add('http://h/path');
        try {
            for (const p of ['/', '/f/index.html', '/f/doc.pdf', '/meta']) {
                const r = await get(port, '/v/' + t2 + p, { host: 'other:1881' });
                assert.match(r.headers['content-security-policy'], /frame-ancestors 'self' https:\/\/nr\.lan:1880 http:\/\/\[::1\]:1880$/, p);
            }
        } finally {
            origins.clear();
        }
    });

    it('sends one themed dead link page for a bad, an expired or a deleted ticket', async () => {
        const dead = await get(port, '/v/nonsense/');
        const expired = ticket.make(store.key, ID, 1, 1000, Date.now() - 2000);
        for (const t of ['nonsense', expired, tDel, ticket.make(store.key, ID, 9), ticket.make(store.key, 'ffffffffffffffff', 1)]) {
            const r = await get(port, '/v/' + t + '/');
            assert.equal(r.status, 404);
            assert.equal(r.body.toString(), dead.body.toString(), 'one page for each case');
            assert.equal((await get(port, '/v/' + t + '/meta')).status, 404);
        }
        assert.match(dead.body.toString(), /<title>Link not valid<\/title>.*<h1>Link not valid<\/h1><p>This link does not work\. It may have expired\. Ask the sender for a new link\.<\/p>/);
        assert.match(dead.body.toString(), /prefers-color-scheme: dark/);
        const csp = dead.headers['content-security-policy'];
        assert.match(csp, /^default-src 'none'; script-src 'sha256-[A-Za-z0-9+/]+=*'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'$/);
        // The one script of the page tells the editor that the server answered. The CSP allows it by its hash only.
        const scripts = [...dead.body.toString().matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
        assert.equal(scripts.length, 1);
        assert.equal(csp.match(/'sha256-([^']+)'/)[1], crypto.createHash('sha256').update(scripts[0]).digest('base64'));
        const sent = [];
        const parent = { postMessage: (data, origin) => sent.push([data, origin]) };
        vm.runInNewContext(scripts[0], { parent, window: {} });
        assert.deepEqual(JSON.parse(JSON.stringify(sent)), [[{ type: 'loaded' }, '*']]);
        const dark = (await get(port, '/v/nonsense/?theme=dark')).body.toString();
        assert.match(dark, /--bg:#1b1b23/);
        assert.doesNotMatch(dark, /prefers-color-scheme|#ffffff/);
    });

    it('adds the path script only to an HTML page that loads in a frame', async () => {
        const plain = await get(port, '/v/' + t2 + '/f/index.html');
        const framed = await get(port, '/v/' + t2 + '/f/index.html', { 'sec-fetch-dest': 'iframe' });
        assert.equal(plain.body.toString(), '<h1>Hi</h1><script>1</script>');
        assert.equal(framed.body.toString(), "<h1>Hi</h1><script>1</script>\n<script>parent.postMessage({ type: 'claude-agent:at', path: location.pathname }, '*')</script>\n");
        assert.equal(Number(framed.headers['content-length']), framed.body.length);
        assert.match(framed.headers['content-security-policy'], /^sandbox allow-scripts /);
        const head = await get(port, '/v/' + t2 + '/f/index.html', { 'sec-fetch-dest': 'iframe' }, 'HEAD');
        assert.equal(head.headers['content-length'], framed.headers['content-length']);
        const part = await get(port, '/v/' + t2 + '/f/index.html', { 'sec-fetch-dest': 'iframe', range: 'bytes=0-3' });
        assert.equal(part.body.toString(), '<h1>');
        assert.equal((await get(port, '/v/' + t2 + '/f/big.txt', { 'sec-fetch-dest': 'iframe' })).body.length, 11000);
        const dl = await get(port, '/v/' + ticket.make(store.key, ID_HTML, 1) + '/download', { 'sec-fetch-dest': 'iframe' });
        assert.equal(dl.body.toString(), '<p>one</p>');
    });

    it('gives the editor URL in meta only from a known origin with the hostname of the request', async () => {
        origins.add('http://nr.lan:1880').add('https://other.lan:1880').add('http://[::1]:1880');
        try {
            const m = async (host) => JSON.parse((await get(port, '/v/' + t2 + '/meta', { host })).body);
            assert.equal((await m('nr.lan:1881')).editor, 'http://nr.lan:1880/admin/#files/' + ID + '/2');
            assert.equal((await m('NR.lan:1881')).editor, 'http://nr.lan:1880/admin/#files/' + ID + '/2');
            assert.equal((await m('[::1]:1881')).editor, 'http://[::1]:1880/admin/#files/' + ID + '/2');
            const r = await get(port, '/v/' + t2 + '/meta', { host: 'third.lan:1881' });
            assert.equal(JSON.parse(r.body).editor, undefined, 'no fallback to another origin');
            assert.equal(r.headers['cache-control'], 'private, no-store');
            assert.equal((await m('bad host!')).editor, undefined);
        } finally {
            origins.clear();
        }
    });

    it('redirects /v/<ticket> to /v/<ticket>/ so that relative links work', async () => {
        const r = await get(port, '/v/' + t1 + '?theme=light');
        assert.equal(r.status, 302);
        assert.equal(r.headers.location, '/v/' + t1 + '/?theme=light');
    });

    it('gives the version in meta, with the owner address and no run', async () => {
        const r = await get(port, '/v/' + t2 + '/meta');
        const m = JSON.parse(r.body);
        assert.equal(m.n, 2);
        assert.equal(m.newest, true, 'version 3 is deleted, so version 2 is the newest');
        assert.equal(m.entry, 'index.html');
        assert.equal(m.files.length, 6);
        assert.equal(m.owner, 't/a');
        assert.equal(m.run, undefined);
        assert.equal(m.editor, undefined, 'no known editor origin');
        assert.equal(JSON.parse((await get(port, '/v/' + t1 + '/meta')).body).newest, false);
    });

    it('serves a file with the sandbox CSP and no same origin', async () => {
        const r = await get(port, '/v/' + t2 + '/f/index.html');
        assert.equal(r.status, 200);
        assert.equal(r.headers['content-type'], 'text/html; charset=utf-8');
        const csp = r.headers['content-security-policy'];
        assert.match(csp, /^sandbox allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads; default-src 'self' data: blob: 'unsafe-inline' 'unsafe-eval' https:; frame-ancestors 'self' http:\/\/127\.0\.0\.1:1880 https:\/\/127\.0\.0\.1:1880$/);
        assert.doesNotMatch(csp, /allow-same-origin|allow-top-navigation/);
        assert.equal((await get(port, '/v/' + t2 + '/f/img/a%20b.png')).headers['content-type'], 'image/png');
    });

    it('leaves out https: when htmlNetwork is false', async () => {
        const s = http.createServer(view.handler({ store, htmlNetwork: false }));
        await new Promise(r => s.listen(0, '127.0.0.1', r));
        const r = await get(s.address().port, '/v/' + t2 + '/f/index.html');
        s.close();
        assert.match(r.headers['content-security-policy'], /'unsafe-eval'; frame-ancestors/);
    });

    it('finds a file only by an exact path of the file list', async () => {
        for (const p of ['f/../secret.txt', 'f/%2e%2e/secret.txt', 'f/..%2fsecret.txt', 'f/img/../index.html', 'f/img%2fa%20b.png',
            'f//index.html', 'f/INDEX.html', 'f/%E0%A4%A', 'f/', 'other']) {
            const r = await get(port, '/v/' + t2 + '/' + p);
            if (p === 'f/img%2fa%20b.png') { assert.equal(r.status, 200, 'an encoded slash is a part of the name'); continue; }
            assert.equal(r.status, 404, p);
        }
        assert.equal((await get(port, '/v/' + t1 + '/f/index.html')).status, 404, 'a file of another version');
    });

    it('serves a real PDF with no sandbox, and a fake PDF as a download type with the sandbox', async () => {
        const real = await get(port, '/v/' + t2 + '/f/doc.pdf');
        assert.equal(real.headers['content-type'], 'application/pdf');
        assert.match(real.headers['content-security-policy'], /^frame-ancestors 'self' /, 'no sandbox: Chrome shows no PDF in a sandbox');
        assert.equal(real.headers['x-content-type-options'], 'nosniff');
        const fake = await get(port, '/v/' + t2 + '/f/fake.pdf');
        assert.equal(fake.headers['content-type'], 'application/octet-stream');
        assert.match(fake.headers['content-security-policy'], /^sandbox /);
    });

    it('serves a byte range, for the seek of audio and video', async () => {
        const p = '/v/' + t2 + '/f/big.txt';
        let r = await get(port, p, { range: 'bytes=5000-5005' });
        assert.equal(r.status, 206);
        assert.equal(r.headers['content-range'], 'bytes 5000-5005/11000');
        assert.equal(r.body.toString(), 'abcabc');
        r = await get(port, p, { range: 'bytes=-3' });
        assert.equal(r.body.toString(), 'abc');
        r = await get(port, p, { range: 'bytes=20000-' });
        assert.equal(r.status, 416);
        r = await get(port, p, { range: 'bytes=0-1,5-6' });
        assert.equal(r.status, 200, 'more than one range gives the full file');
        assert.equal(r.body.length, 11000);
        r = await get(port, '/v/' + t2 + '/f/empty.bin');
        assert.equal(r.status, 200);
        assert.equal(r.body.length, 0);
        r = await get(port, p, {}, 'HEAD');
        assert.equal(r.headers['content-length'], '11000');
        assert.equal(r.body.length, 0);
    });

    it('downloads one file with its name, and a folder as a zip', async () => {
        const one = await get(port, '/v/' + t1 + '/download');
        assert.equal(one.headers['content-type'], 'application/octet-stream');
        assert.equal(one.headers['content-disposition'], 'attachment; filename="Report-v1.md"; filename*=UTF-8\'\'Report-v1.md');
        assert.match(one.headers['content-security-policy'], /^sandbox /);
        assert.equal(one.body.toString(), '# Report\n\nHello ü\n');
        const zip = await get(port, '/v/' + t2 + '/download');
        assert.match(zip.headers['content-disposition'], /filename="Report-v2\.zip"/);
        const files = unzip(zip.body);
        assert.deepEqual(files.map(f => f.path), store.records[ID].versions[1].files.map(f => f.path));
        assert.equal(files.find(f => f.path === 'big.txt').data.length, 11000);
        assert.equal(files.find(f => f.path === 'img/a b.png').data.toString('hex'), '89504e47');
    });

    it('gives a thumbnail only for an entry image of 1 MB or less', async () => {
        const small = await get(port, '/v/' + ticket.make(store.key, ID_IMG, 1) + '/thumb');
        assert.equal(small.status, 200);
        assert.equal(small.headers['content-type'], 'image/png');
        assert.match(small.headers['content-security-policy'], /^sandbox /);
        assert.equal(small.body.toString('hex'), '89504e47');
        assert.equal((await get(port, '/v/' + ticket.make(store.key, ID_IMG, 2) + '/thumb')).status, 404);
        assert.equal((await get(port, '/v/' + t1 + '/thumb')).status, 404);
    });

    it('accepts only GET and HEAD', async () => {
        const r = await get(port, '/v/' + t1 + '/meta', {}, 'POST');
        assert.equal(r.status, 405);
        assert.equal(r.headers.allow, 'GET, HEAD');
    });

    it('serves only the fixed list of viewer files', async () => {
        for (const p of ['viewer.js', 'viewer.css', 'renderers/markdown.js', 'lib/marked.js', 'lib/purify.js']) {
            assert.equal((await get(port, '/viewer/' + p)).status, 200, p);
        }
        for (const p of ['index.html', '../viewer.js', '%2e%2e/view-server.js', 'constructor', 'renderers/', 'lib/']) {
            assert.equal((await get(port, '/viewer/' + p)).status, 404, p);
        }
        assert.equal((await get(port, '/viewer/viewer.css')).headers['content-type'], 'text/css; charset=utf-8');
    });

    it('keeps an element with the hidden attribute out of view', () => {
        const css = fs.readFileSync(path.join(VIEWER, 'viewer.css'), 'utf8');
        assert.match(css, /\[hidden\]\s*\{\s*display:\s*none\s*!important/);
    });

    it('loads each renderer file of the folder in the viewer page', () => {
        const html = fs.readFileSync(path.join(VIEWER, 'index.html'), 'utf8');
        for (const name of fs.readdirSync(path.join(VIEWER, 'renderers'))) {
            assert.ok(html.includes('src="/viewer/renderers/' + name + '"'), name);
        }
    });
});

describe('start', () => {
    it('serves on the port, and stops on close', async () => {
        const store = { key: Buffer.alloc(32), record: () => null, version: () => undefined };
        const v = await view.start({ store, port: 0, bind: '127.0.0.1', settings: { htmlNetwork: true } });
        assert.ok(v.port > 0);
        assert.equal((await get(v.port, '/v/x/')).status, 404);
        await v.close();
        await assert.rejects(get(v.port, '/v/x/'));
    });

    it('rejects when the port is in use', async () => {
        const store = { key: Buffer.alloc(32), record: () => null, version: () => undefined };
        const a = await view.start({ store, port: 0, bind: '127.0.0.1' });
        await assert.rejects(view.start({ store, port: a.port, bind: '127.0.0.1' }), /EADDRINUSE/);
        await a.close();
    });
});

// ---- The renderers, in a small fake DOM

function loadViewer(parent) {
    const registered = [];
    const fakeEl = () => ({ dataset: {}, addEventListener() {}, setAttribute() {}, append() {}, replaceChildren() {} });
    const context = {
        location: { pathname: '/v/T/', hash: '', search: '' },
        document: { documentElement: { dataset: { theme: 'light' } }, addEventListener() {}, createElement: fakeEl, getElementById: fakeEl },
        matchMedia: () => ({ matches: false, onchange: null }), URLSearchParams, TextDecoder, fetch: async () => { throw new Error('no fetch'); }
    };
    context.window = context;
    context.parent = parent || context;
    vm.createContext(context);
    const html = fs.readFileSync(path.join(VIEWER, 'index.html'), 'utf8');
    vm.runInContext(fs.readFileSync(path.join(VIEWER, 'viewer.js'), 'utf8'), context);
    const reg = context.viewer.register;
    context.viewer.register = (r) => { registered.push(r); reg(r); };
    for (const [, name] of html.matchAll(/src="\/viewer\/renderers\/([a-z-]+\.js)"/g)) {
        vm.runInContext(fs.readFileSync(path.join(VIEWER, 'renderers', name), 'utf8'), context);
    }
    vm.runInContext(fs.readFileSync(path.join(VIEWER, 'compare.js'), 'utf8'), context);
    return { viewer: context.viewer, registered, context };
}

describe('the loaded message', () => {
    it('goes to the editor as soon as the script runs, before the meta request and the render', () => {
        const sent = [];
        // The fake document never fires DOMContentLoaded, so main() does not run
        loadViewer({ postMessage: (data, origin) => sent.push([data, origin]) });
        assert.deepEqual(JSON.parse(JSON.stringify(sent)), [[{ type: 'loaded' }, '*']]);
    });

    it('is sent one time only, not again on a hash change', () => {
        const src = fs.readFileSync(path.join(VIEWER, 'viewer.js'), 'utf8');
        assert.equal(src.match(/postMessage\(/g).length, 1);
    });
});

describe('the renderers', () => {
    const { viewer, registered, context } = loadViewer();
    const pick = (type, extra) => registered.find(r => r.match(Object.assign({ path: 'x', type }, extra))).name;

    it('picks the renderer for each type', () => {
        const want = {
            'text/markdown': 'markdown', 'image/png': 'image', 'image/svg+xml': 'image', 'image/jpeg': 'image',
            'application/pdf': 'pdf', 'audio/mpeg': 'media', 'video/mp4': 'media', 'text/html': 'html',
            'text/plain': 'text', 'application/javascript': 'text', 'application/ld+json': 'json', 'application/json': 'json',
            'text/csv': 'csv', 'text/tab-separated-values': 'csv',
            'application/octet-stream': 'other', 'application/zip': 'other', 'image/tiff': 'other'
        };
        for (const [type, name] of Object.entries(want)) assert.equal(pick(type), name, type);
        assert.equal(pick('application/octet-stream', { isText: true }), 'text');
    });

    it('reads CSV and TSV with quotes, line breaks in quotes and a BOM', () => {
        const { parse } = registered.find(r => r.name === 'csv');
        const rows = (text, sep) => JSON.parse(JSON.stringify(parse(text, sep)));
        assert.deepEqual(rows('\ufeffa,b\r\n1,"x, ""y""\nz"\n2,\n', ','), [['a', 'b'], ['1', 'x, "y"\nz'], ['2', '']]);
        assert.deepEqual(rows('a\tb\n1\t2', '\t'), [['a', 'b'], ['1', '2']]);
        assert.deepEqual(rows('', ','), []);
    });

    it('sorts numbers as numbers, text as text, and an empty cell last', () => {
        const { compare } = registered.find(r => r.name === 'csv');
        assert.deepEqual(['10', '', '9', '-1.5', '2e1'].sort(compare), ['-1.5', '9', '10', '2e1', '']);
        assert.deepEqual(['b10', 'B2', 'a'].sort(compare), ['a', 'B2', 'b10']);
        const down = (x, y) => compare(x, y, -1);
        assert.deepEqual(['10', '', '9', '-1.5', ''].sort(down), ['10', '9', '-1.5', '', ''], 'an empty cell stays last in the down sort');
        assert.deepEqual(['a', '', 'B2'].sort(down), ['B2', 'a', '']);
    });

    it('keeps the exact text of a JSON number that a JavaScript number cannot hold', () => {
        const { parse } = registered.find(r => r.name === 'json');
        const v = parse('{"id": 12345678901234567890, "n": 1.5, "s": "x"}');
        assert.equal(v.id.text, '12345678901234567890');
        assert.equal(v.n, 1.5);
        assert.throws(() => parse('{bad'));
    });

    it('shows the version line of the top bar as "Version 3 · 18 Nov 2026"', () => {
        assert.equal(viewer.versionText({ n: 3, newest: true, time: Date.UTC(2026, 10, 18, 12) }), 'Version 3 · 18 Nov 2026');
    });

    it('resolves a relative link inside the artifact only', () => {
        assert.equal(viewer.resolve('docs/a.md', 'b.png'), 'docs/b.png');
        assert.equal(viewer.resolve('docs/a.md', '../img/c.png'), 'img/c.png');
        assert.equal(viewer.resolve('docs/a.md', './x/../y.md'), 'docs/y.md');
        assert.equal(viewer.resolve('a.md', '../../etc/passwd'), null);
    });

    it('makes a real link to a file and to a heading, with the file in the hash', () => {
        assert.equal(viewer.link('docs/a b.md'), '#file=docs%2Fa%20b.md');
        assert.equal(viewer.link('a.md', 'intro-text'), '#file=a.md&at=intro-text');
    });

    it('gives each Contents link the hash of its file and its heading', async () => {
        // A fake DOM: the article holds 3 headings, the renderer makes the outline from them
        const made = [];
        const node = (tag) => {
            const n = { tagName: tag.toUpperCase(), attrs: {}, children: [], style: {}, classList: { remove() {}, toggle() {} },
                setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return this.attrs[k]; },
                addEventListener() {}, append(...c) { this.children.push(...c); }, replaceChildren(...c) { this.children = c; },
                querySelectorAll: (q) => tag === 'article' && /^h1/.test(q) ? heads : [], querySelector: () => null };
            made.push(n);
            return n;
        };
        const heads = [['H1', 'Report'], ['H2', 'Intro text'], ['H2', 'Intro text']].map(([tagName, textContent]) => ({ tagName, textContent }));
        Object.assign(context, { marked: { parse: () => '' }, DOMPurify: { sanitize: () => '' }, CSS: { escape: (x) => x } });
        context.document.createElement = node;
        viewer.meta = { files: [{ path: 'docs/a b.md', type: 'text/markdown' }] };
        const md = registered.find(r => r.name === 'markdown');
        await md.render(node('div'), viewer.meta.files[0], { text: async () => '', url: viewer.url });
        const nav = made.find(n => n.tagName === 'NAV');
        assert.deepEqual(nav.children.map(a => a.getAttribute('href')), [
            '#file=docs%2Fa%20b.md&at=report', '#file=docs%2Fa%20b.md&at=intro-text', '#file=docs%2Fa%20b.md&at=intro-text-2']);
        assert.deepEqual(heads.map(h => h.id), ['h-report', 'h-intro-text', 'h-intro-text-2']);
    });

    it('keeps the browser action for a middle click and a click with a modifier key', () => {
        const click = (o) => viewer.plainClick(Object.assign({ button: 0, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false }, o));
        assert.equal(click({}), true);
        for (const o of [{ button: 1 }, { ctrlKey: true }, { shiftKey: true }, { altKey: true }, { metaKey: true }]) assert.equal(click(o), false);
    });

    it('makes the URL of a file below the ticket', () => {
        assert.equal(viewer.url('img/a b#.png'), '/v/T/f/img/a%20b%23.png');
    });

    it('diffs two versions line by line with the line numbers of each side', () => {
        const ops = (a, b) => JSON.parse(JSON.stringify(viewer.diff(a, b))).map(o => o.op[0] + (o.a || '') + ':' + (o.b || '') + ' ' + o.text);
        assert.deepEqual(ops(['a', 'b', 'c'], ['a', 'x', 'c', 'd']), ['s1:1 a', 'd2: b', 'a:2 x', 's3:3 c', 'a:4 d']);
        assert.deepEqual(ops([], ['a']), ['a:1 a']);
        assert.deepEqual(ops(['a'], []), ['d1: a']);
        assert.deepEqual(ops(['a', 'b'], ['a', 'b']), ['s1:1 a', 's2:2 b']);
        assert.deepEqual(ops(['x', 'a', 'b'], ['a', 'b', 'y']), ['d1: x', 's2:1 a', 's3:2 b', 'a:3 y']);
    });

    it('lays out the diff with a head, the changes, 3 same lines of context and hidden runs', () => {
        const A = Array.from({ length: 20 }, (_, i) => 'l' + i), B = A.slice();
        B[10] = 'x';
        B.push('y', 'z');
        const ops = viewer.diff(A, B);
        const show = (narrow) => JSON.parse(JSON.stringify(viewer.diffLayout(ops, narrow))).map(i => i.head ? 'head'
            : i.more ? 'more ' + i.more[0].a + '-' + i.more[i.more.length - 1].a
            : i.row.map(o => o ? o.op[0] + (o.a || o.b) : '_').join(' '));
        assert.deepEqual(show(false), ['head', 'more 1-7', 's8 s8', 's9 s9', 's10 s10', 'd11 a11', 's12 s12', 's13 s13', 's14 s14',
            'more 15-17', 's18 s18', 's19 s19', 's20 s20', '_ a21', '_ a22']);
        assert.deepEqual(show(true).slice(4, 7), ['s10', 'd11', 'a11']);
        assert.equal(show(true).length, 16);
        assert.deepEqual(JSON.parse(JSON.stringify(viewer.diffLayout(viewer.diff(['a'], ['b']), false))).length, 2);
    });

    it('gives the base path of the version for the other ticket of a compare', () => {
        assert.equal(viewer.base, '/v/T/');
    });

    it('gives no diff when the changed part is too large for the table', () => {
        const a = Array.from({ length: 2001 }, (_, i) => 'a' + i), b = Array.from({ length: 2001 }, (_, i) => 'b' + i);
        assert.equal(viewer.diff(a, b), null);
        assert.equal(viewer.diff(['h', ...a.slice(0, 1000), 't'], ['h', ...b.slice(0, 1000), 't']).length, 2002);
    });
});
