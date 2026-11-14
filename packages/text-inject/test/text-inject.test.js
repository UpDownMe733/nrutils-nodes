'use strict';

// Starts one real Node-RED in a scratch user dir, deploys a test flow and sends text to the
// text-inject node, the same way as its popup in the editor does.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

const REPO = path.resolve(__dirname, '..');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** Poll fn until it returns a truthy value, or throw after timeoutMs. */
async function waitFor(fn, timeoutMs, what) {
    const end = Date.now() + timeoutMs;
    for (;;) {
        const value = await fn().catch(() => null);
        if (value) return value;
        if (Date.now() > end) throw new Error('Timeout: ' + what);
        await sleep(50);
    }
}

function freePort() {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.listen(0, '127.0.0.1', () => {
            const { port } = srv.address();
            srv.close(() => resolve(port));
        });
        srv.on('error', reject);
    });
}

// Stores each message it gets in the global context under its key
const collect = (key) => ({ id: 'collect-' + key, type: 'function', z: 'tab', outputs: 0, wires: [],
    func: `global.set(${JSON.stringify(key)}, (global.get(${JSON.stringify(key)}) || []).concat([msg]));` });

const FLOW = [
    { id: 'tab', type: 'tab', label: 'test' },
    { id: 'text', type: 'text-inject', z: 'tab', name: '', wires: [['collect-out']] }, collect('out'),
    { id: 'status-text', type: 'status', z: 'tab', scope: ['text'], wires: [['collect-status']] }, collect('status'),
    // GET /results/<key> answers with the messages that collect(key) stored
    { id: 'http-results', type: 'http in', z: 'tab', url: '/results/:key', method: 'get', wires: [['results']] },
    { id: 'results', type: 'function', z: 'tab', outputs: 1, wires: [['results-response']],
        func: 'msg.payload = global.get(msg.req.params.key) || []; return msg;' },
    { id: 'results-response', type: 'http response', z: 'tab', wires: [] }
];

describe('text-inject in a real Node-RED', { timeout: 60000 }, () => {
    let child, base, userDir;
    let log = '';

    const results = (key, count = 1) => waitFor(async () => {
        const list = await (await fetch(`${base}/results/${key}`)).json();
        return list.length >= count && list;
    }, 5000, 'results of ' + key);
    // The request that the Send button of the popup makes
    const send = (nodeId, payload) => fetch(`${base}/node_red_editorcomms`, { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nodeId, messageType: 'send', payload }) });

    before(async () => {
        userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nrutils-nodes-test-'));
        // The package, as npm install puts it in the user dir
        fs.mkdirSync(path.join(userDir, 'node_modules', '@nrutils'), { recursive: true });
        fs.symlinkSync(REPO, path.join(userDir, 'node_modules', '@nrutils', 'node-red-text-inject'));

        const port = await freePort();
        base = `http://127.0.0.1:${port}`;
        fs.writeFileSync(path.join(userDir, 'settings.js'), `module.exports = {
            uiHost: '127.0.0.1', uiPort: ${port}, flowFile: 'flows.json', credentialSecret: false,
            diagnostics: { enabled: false }, telemetry: { enabled: false }
        };`);
        child = spawn(process.execPath, [require.resolve('node-red/red.js'), '-u', userDir, '-s', path.join(userDir, 'settings.js')],
            { stdio: ['ignore', 'pipe', 'pipe'] });
        child.stdout.on('data', d => { log += d; });
        child.stderr.on('data', d => { log += d; });
        await waitFor(async () => (await fetch(base + '/settings')).ok, 30000, 'Node-RED start');
        const res = await fetch(base + '/flows', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(FLOW) });
        assert.equal(res.status, 204, await res.text());
        await waitFor(async () => (await fetch(`${base}/results/none`)).ok, 5000, 'flow start');
    });

    after(async () => {
        if (child && child.exitCode === null) {
            const exited = new Promise(r => child.once('exit', r));
            child.kill('SIGTERM');
            await Promise.race([exited, sleep(5000)]);
            if (child.exitCode === null) child.kill('SIGKILL');
        }
        if (userDir) fs.rmSync(userDir, { recursive: true, force: true });
    });

    it('the text of the popup goes out as msg.payload, and the answer is its length', async () => {
        const res = await send('text', 'hello\nworld');
        assert.equal(res.status, 200);
        assert.equal((await res.json()).result, 11);
        assert.equal((await results('out'))[0].payload, 'hello\nworld');
        assert.equal((await results('status'))[0].status.text, 'sent 11 chars');
    });

    it('a value that is not a string sends nothing and gives an error', async () => {
        const res = await send('text', 5);
        assert.equal(res.status, 500);
        assert.equal((await res.json()).error, 'text must be a string');
        await sleep(200);
        assert.equal((await results('out')).length, 1);
    });

    it('a node that is not deployed gets no handler', async () => {
        assert.equal((await send('no-such-node', 'x')).status, 404);
    });
});
