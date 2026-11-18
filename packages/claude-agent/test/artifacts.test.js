'use strict';

// The artifacts: the tar reader, the ticket, the store and the publish tool.
// The last part starts one real Node-RED with the fake launcher and an agentExec script.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { tarReader } = require('../artifacts/tar');
const ticket = require('../artifacts/ticket');
const { createStore } = require('../artifacts/store');
const { readFiles } = require('../artifacts');

const REPO = path.resolve(__dirname, '..');
const FAKE = path.join(__dirname, 'fixtures', 'fake-claude.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), 'nrutils-artifacts-'));

async function waitFor(fn, timeoutMs, what) {
    const end = Date.now() + timeoutMs;
    for (;;) {
        const value = await fn().catch(() => null);
        if (value) return value;
        if (Date.now() > end) throw new Error('Timeout: ' + what);
        await sleep(50);
    }
}

// One tar entry made by hand: header and padded body
function entry(name, { type = '0', body = '', linkname = '' } = {}) {
    const h = Buffer.alloc(512);
    h.write(name, 0);
    h.write('0000644\0', 100);
    h.write('0000000\0', 108);
    h.write('0000000\0', 116);
    h.write(Buffer.byteLength(body).toString(8).padStart(11, '0') + '\0', 124);
    h.write('00000000000\0', 136);
    h.write('        ', 148);
    h.write(type, 156);
    h.write(linkname, 157);
    h.write('ustar\x0000', 257);
    let sum = 0;
    for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    const data = Buffer.from(body);
    return Buffer.concat([h, data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
}
const archive = (...entries) => Buffer.concat([...entries, Buffer.alloc(1024)]);
const read = (buf, limits = { maxBytes: 1e6, maxFiles: 100 }) => {
    const r = tarReader(limits);
    r.write(buf);
    return r.end();
};

describe('tar reader', () => {
    it('reads files and folders', () => {
        const got = read(archive(entry('dir/', { type: '5' }), entry('dir/a.txt', { body: 'hello' })));
        assert.equal(got.folder, true);
        assert.deepEqual(got.files.map((f) => [f.path, f.data.toString()]), [['dir/a.txt', 'hello']]);
    });
    it('reads a stream in small pieces', () => {
        const buf = archive(entry('a.txt', { body: 'x'.repeat(700) }));
        const r = tarReader({ maxBytes: 1e6, maxFiles: 10 });
        for (let i = 0; i < buf.length; i += 100) r.write(buf.subarray(i, i + 100));
        assert.equal(r.end().files[0].data.length, 700);
    });
    it('reads a real tar archive with a long name', () => {
        const dir = scratch();
        const deep = path.join(dir, 'd'.repeat(90), 'e'.repeat(90));
        fs.mkdirSync(deep, { recursive: true });
        fs.writeFileSync(path.join(deep, 'f.txt'), 'long');
        const got = read(execFileSync('tar', ['-cf', '-', '--', 'd'.repeat(90)], { cwd: dir, maxBuffer: 1e7 }));
        assert.equal(got.files[0].path, `${'d'.repeat(90)}/${'e'.repeat(90)}/f.txt`);
        fs.rmSync(dir, { recursive: true });
    });
    for (const [what, type] of [['a symbolic link', '2'], ['a hard link', '1'], ['a device', '3'], ['a FIFO', '6']]) {
        it(`stops on ${what}`, () => assert.throws(() => read(archive(entry('x', { type, linkname: '/etc/passwd' }))), /not a plain file/));
    }
    for (const name of ['/etc/passwd', '../x', 'a/../../x']) {
        it(`stops on the name ${name}`, () => assert.throws(() => read(archive(entry(name, { body: 'x' }))), /not allowed/));
    }
    it('stops on a header with a wrong check sum', () => {
        const buf = archive(entry('a', { body: 'x' }));
        buf[0] ^= 1;
        assert.throws(() => read(buf), /not valid/);
    });
    it('stops on a stream that is not complete', () => assert.throws(() => read(entry('a', { body: 'x' }).subarray(0, 600)), /not complete/));
    it('stops at the limits', () => {
        const two = archive(entry('a', { body: 'x'.repeat(10) }), entry('b', { body: 'x'.repeat(10) }));
        assert.throws(() => read(two, { maxBytes: 15, maxFiles: 5 }), (e) => e.limit === 'bytes');
        assert.throws(() => read(two, { maxBytes: 1e6, maxFiles: 1 }), (e) => e.limit === 'files');
    });
});

describe('ticket', () => {
    const key = Buffer.from('k'.repeat(32));
    const id = '0123456789abcdef';
    it('opens the version that it names', () => assert.deepEqual(ticket.verify(key, ticket.make(key, id, 3)), { id, n: 3 }));
    it('is not valid with another key', () => assert.equal(ticket.verify(Buffer.from('j'.repeat(32)), ticket.make(key, id, 3)), null));
    it('is not valid after the end time', () => assert.equal(ticket.verify(key, ticket.make(key, id, 3, 1000, 5000), 7000), null));
    it('is not valid when the text changes', () => {
        const [body, mac] = ticket.make(key, id, 3).split('.');
        const other = Buffer.from(Buffer.from(body, 'base64url').toString().replace('|3|', '|4|')).toString('base64url');
        assert.equal(ticket.verify(key, `${other}.${mac}`), null);
        assert.equal(ticket.verify(key, 'x'), null);
        assert.equal(ticket.verify(key, undefined), null);
    });
});

describe('store', () => {
    let dir, store;
    const input = (files, more = {}) => ({ nodeId: 'n1', address: 'team/agent', defaultName: 'Report.md', files: files.map(([p, t]) => ({ path: p, data: Buffer.from(t) })), ...more });
    before(() => { dir = scratch(); store = createStore(path.join(dir, 'store')); });
    after(() => fs.rmSync(dir, { recursive: true, force: true }));

    it('makes version 1 with the title of the first heading', async () => {
        const r = await store.publish(input([['Report.md', '# Load test\ntext']]));
        assert.equal(r.record.name, 'report.md');
        assert.equal(r.version.n, 1);
        assert.equal(r.version.title, 'Load test');
        assert.equal(r.version.files[0].type, 'text/markdown');
        assert.equal(fs.readFileSync(store.blobPath(r.version.files[0].sha256), 'utf8'), '# Load test\ntext');
    });
    it('makes no new version for the same content', async () => {
        const r = await store.publish(input([['Report.md', '# Load test\ntext']]));
        assert.equal(r.unchanged, true);
        assert.equal(r.record.versions.length, 1);
    });
    it('makes version 2 for a change, and the list shows the newest', async () => {
        const r = await store.publish(input([['Report.md', '# Load test 2']], { note: 'second' }));
        assert.equal(r.version.n, 2);
        assert.equal(r.version.note, 'second');
        const [item] = store.list();
        assert.equal(item.version, 2);
        assert.equal(item.versions, 2);
        assert.equal(item.title, 'Load test 2');
    });
    it('keeps version 1 open', () => assert.equal(store.file(store.idOf('n1', 'report.md'), 1, 'Report.md').size, 16));
    it('picks index.html as the entry of a folder', async () => {
        const r = await store.publish(input([['a.txt', 'a'], ['index.html', '<title>Page</title>']], { name: 'site' }));
        assert.equal(r.version.entry, 'index.html');
        assert.equal(r.version.title, 'Page');
    });
    it('refuses an entry that is not in the files and a name against the rule', async () => {
        await assert.rejects(store.publish(input([['a.txt', 'a']], { entry: 'b.txt' })), /not in the files/);
        await assert.rejects(store.publish(input([['a.txt', 'a']], { name: 'Bad Name' })), /must match/);
    });
    it('filters the list', () => {
        assert.equal(store.list({ q: 'page' }).length, 1);
        assert.equal(store.list({ type: 'text/markdown' }).length, 1);
        assert.equal(store.list({ owner: 'team/other' }).length, 0);
    });
    it('reads the records again at the next start and keeps the key', () => {
        const again = createStore(path.join(dir, 'store'));
        assert.equal(again.list().length, 2);
        assert.ok(again.key.equals(store.key));
        assert.equal(fs.statSync(path.join(dir, 'store', 'key')).mode & 0o777, 0o600);
    });
});

describe('readFiles', () => {
    let dir, exec;
    const settings = (more = {}) => ({ launcher: null, agentExec: null, workRoot: dir, artifacts: { maxBytes: 1000, maxFiles: 3 }, ...more });
    before(() => {
        dir = scratch();
        fs.mkdirSync(path.join(dir, 'out', 'sub'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'out', 'sub', 'a.txt'), 'aaa');
        fs.writeFileSync(path.join(dir, 'one.txt'), 'one');
        fs.writeFileSync(path.join(dir, 'big.bin'), Buffer.alloc(2000));
        fs.symlinkSync('/etc/hostname', path.join(dir, 'link'));
        fs.mkdirSync(path.join(dir, 'links'));
        fs.symlinkSync('/etc/hostname', path.join(dir, 'links', 'x'));
        for (let i = 0; i < 4; i++) fs.writeFileSync(path.join(dir, 'out', `f${i}`), 'x');
        exec = path.join(dir, 'exec.sh');
        fs.writeFileSync(exec, '#!/bin/sh\ncd "$2" || exit 1\nshift 2\nexec "$@"\n', { mode: 0o755 });
    });
    after(() => fs.rmSync(dir, { recursive: true, force: true }));

    it('reads a file', async () => {
        const got = await readFiles(settings(), { dir, base: 'one.txt' });
        assert.deepEqual(got.files.map((f) => f.path), ['one.txt']);
        assert.equal(got.folder, false);
    });
    it('reads a file through agentExec', async () => {
        const got = await readFiles(settings({ launcher: 'x', agentExec: exec }), { dir, base: 'one.txt' });
        assert.equal(got.files[0].data.toString(), 'one');
    });
    it('reads a folder', async () => {
        const got = await readFiles(settings({ artifacts: { maxBytes: 1000, maxFiles: 50 } }), { dir, base: 'out' });
        assert.equal(got.folder, true);
        assert.ok(got.files.some((f) => f.path === 'out/sub/a.txt'));
    });
    it('stops at the byte limit and the file limit', async () => {
        await assert.rejects(readFiles(settings(), { dir, base: 'big.bin' }), /larger than/);
        await assert.rejects(readFiles(settings(), { dir, base: 'out' }), /more than 3 files/);
    });
    it('stops on a symbolic link', async () => {
        await assert.rejects(readFiles(settings(), { dir, base: 'links' }), /not a plain file/);
    });
    it('gives an error for a path that does not exist', async () => {
        await assert.rejects(readFiles(settings(), { dir, base: 'missing' }), /missing/);
    });
    it('gives an error with a launcher and no agentExec, and with a sandbox and no agentExec', async () => {
        await assert.rejects(readFiles(settings({ launcher: 'x' }), { dir, base: 'one.txt' }), /rights of the agent/);
        await assert.rejects(readFiles(settings(), { dir, base: 'one.txt', sandbox: 'box-1' }), /rights of the agent/);
    });
});

describe('publish in a real Node-RED', { timeout: 60000 }, () => {
    let child, base, userDir, workRoot, socket;
    let log = '';
    const comms = [];
    const api = (p, o) => fetch(base + p, o);
    const results = (key, count = 1) => waitFor(async () => {
        const list = await (await api(`/results/${key}`)).json();
        return list.length >= count && list;
    }, 10000, 'results of ' + key);
    const agent = (id, prompt) => ({ id, type: 'claude-agent', z: 'tab', name: id + ' stage', prompt, cwd: path.join(workRoot, 'project'), sandbox: '', tools: '',
        maxTurns: 30, maxCostUsd: 2, timeoutMin: 30, maxParallel: 1, outputSchema: '', mcpServers: '', wires: [['collect-' + id], [], ['collect-events']] });
    const collect = (key) => ({ id: 'collect-' + key, type: 'function', z: 'tab', outputs: 0, wires: [],
        func: `global.set(${JSON.stringify(key)}, (global.get(${JSON.stringify(key)}) || []).concat([msg]));` });
    const inject = (id, target) => ({ id, type: 'inject', z: 'tab', repeat: '', once: false, wires: [[target]], props: [{ p: 'payload' }], payload: 'go', payloadType: 'str' });
    const run = async (id) => {
        const before = (await (await api(`/results/${id}`)).json()).length;
        await api(`/inject/i-${id}`, { method: 'POST' });
        return (await results(id, before + 1)).pop();
    };

    before(async () => {
        userDir = scratch();
        workRoot = path.join(userDir, 'work');
        fs.mkdirSync(path.join(workRoot, 'project', 'site'), { recursive: true });
        fs.writeFileSync(path.join(workRoot, 'project', 'report.md'), '# The report\nbody');
        fs.writeFileSync(path.join(workRoot, 'project', 'site', 'index.html'), '<h1>Site</h1>');
        fs.writeFileSync(path.join(userDir, 'secret.txt'), 'secret');
        fs.writeFileSync(path.join(workRoot, 'project', 'link.txt'), '');
        fs.rmSync(path.join(workRoot, 'project', 'link.txt'));
        fs.symlinkSync(path.join(userDir, 'secret.txt'), path.join(workRoot, 'project', 'link.txt'));
        fs.writeFileSync(path.join(userDir, 'exec.sh'), '#!/bin/sh\ncd "$2" || exit 1\nshift 2\nexec "$@"\n', { mode: 0o755 });
        fs.mkdirSync(path.join(userDir, 'node_modules', '@nrutils'), { recursive: true });
        fs.symlinkSync(REPO, path.join(userDir, 'node_modules', '@nrutils', 'node-red-claude-agent'));
        const port = await new Promise((resolve, reject) => {
            const srv = net.createServer();
            srv.listen(0, '127.0.0.1', () => { const { port: p } = srv.address(); srv.close(() => resolve(p)); });
            srv.on('error', reject);
        });
        base = `http://127.0.0.1:${port}`;
        fs.writeFileSync(path.join(userDir, 'settings.js'), `module.exports = {
            uiHost: '127.0.0.1', uiPort: ${port}, flowFile: 'flows.json', credentialSecret: false,
            diagnostics: { enabled: false }, telemetry: { enabled: false },
            claudeAgent: { launcher: ${JSON.stringify(FAKE)}, agentExec: ${JSON.stringify(path.join(userDir, 'exec.sh'))}, workRoot: ${JSON.stringify(workRoot)},
                artifacts: { viewPort: 0 } }
        };`);
        child = spawn(process.execPath, [require.resolve('node-red/red.js'), '-u', userDir, '-s', path.join(userDir, 'settings.js')], { stdio: ['ignore', 'pipe', 'pipe'] });
        child.stdout.on('data', (d) => { log += d; });
        child.stderr.on('data', (d) => { log += d; });
        await waitFor(async () => (await api('/settings')).ok, 30000, 'Node-RED start');
        const flow = [{ id: 'tab', type: 'tab', label: 'test' }, collect('events'),
            ...['file', 'again', 'changed', 'folder', 'outside', 'link', 'badname'].flatMap((id) => [inject('i-' + id, id), collect(id)]),
            agent('file', 'publish report.md'), agent('again', 'publish report.md'), agent('changed', 'publish report.md'),
            agent('folder', 'publish site mysite'), agent('outside', `publish ${path.join(userDir, 'secret.txt')}`),
            agent('link', 'publish link.txt'), agent('badname', 'publish report.md Bad_Name'),
            { id: 'http-results', type: 'http in', z: 'tab', url: '/results/:key', method: 'get', wires: [['results']] },
            { id: 'results', type: 'function', z: 'tab', outputs: 1, wires: [['results-response']], func: 'msg.payload = global.get(msg.req.params.key) || []; return msg;' },
            { id: 'results-response', type: 'http response', z: 'tab', wires: [] }];
        const res = await api('/flows', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(flow) });
        assert.equal(res.status, 204, await res.text());
        await waitFor(async () => (await api('/results/none')).ok, 5000, 'flow start');
        socket = new WebSocket(base.replace('http', 'ws') + '/comms');
        socket.onmessage = (e) => {
            for (const m of [].concat(JSON.parse(e.data))) if (m.topic === 'claude-agent/artifacts') comms.push(m.data);
        };
        await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
        socket.send(JSON.stringify({ subscribe: 'claude-agent/artifacts' }));
        await sleep(200);
    });

    after(async () => {
        if (socket) socket.close();
        if (child && child.exitCode === null) {
            const exited = new Promise((r) => child.once('exit', r));
            child.kill('SIGTERM');
            await Promise.race([exited, sleep(5000)]);
            if (child.exitCode === null) child.kill('SIGKILL');
        }
        if (userDir) fs.rmSync(userDir, { recursive: true, force: true });
    });

    it('publishes a file, sends the event and the comms topic, and lists it', async () => {
        const msg = await run('file');
        assert.equal(msg.payload, 'publish replied: Published "The report" as report.md, version 1.');
        const events = await waitFor(async () => (await results('events')).filter((m) => m.agent.kind === 'artifact'), 10000, 'artifact event');
        assert.equal(events[0].agent.artifact.name, 'report.md');
        assert.equal(events[0].agent.artifact.version, 1);
        assert.equal(events[0].agent.artifact.type, 'text/markdown');
        await waitFor(async () => comms.length, 5000, 'comms topic');
        assert.equal(comms[0].record.name, 'report.md');
        const list = await (await api('/claude-agent/artifacts')).json();
        assert.equal(list.length, 1);
        assert.equal(list[0].title, 'The report');
        const record = await (await api(`/claude-agent/artifacts/${list[0].id}`)).json();
        assert.equal(record.versions.length, 1);
    });
    it('makes no new version for the same content', async () => {
        assert.match((await run('again')).payload, /No new version/);
    });
    it('makes a new version when the file changes', async () => {
        fs.writeFileSync(path.join(workRoot, 'project', 'report.md'), '# The report\nnew body');
        assert.match((await run('changed')).payload, /version 2\./);
    });
    it('publishes a folder with the entry index.html', async () => {
        assert.match((await run('folder')).payload, /Published "Site" as mysite, version 1\./);
    });
    it('refuses a path outside the work root', async () => {
        assert.match((await run('outside')).payload, /^publish replied: Error: the path ".*secret.txt" is not in /);
    });
    it('does not publish a symbolic link', async () => {
        assert.match((await run('link')).payload, /^publish replied: Error: .*not a plain file/);
    });
    it('refuses a name against the rule', async () => {
        assert.match((await run('badname')).payload, /^publish replied: Error: the name "Bad_Name" is not valid/);
    });
    it('gives no view ticket when the viewer is off', async () => {
        const [item] = await (await api('/claude-agent/artifacts')).json();
        const res = await api(`/claude-agent/artifacts/${item.id}/1/ticket`, { method: 'POST' });
        assert.equal(res.status, 409);
        assert.equal((await api(`/claude-agent/artifacts/${item.id}/9/ticket`, { method: 'POST' })).status, 404);
        assert.equal((await api('/claude-agent/artifacts/0000000000000000')).status, 404);
    });
});
