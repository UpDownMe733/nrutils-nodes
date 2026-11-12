'use strict';

// Starts one real Node-RED in a scratch user dir, deploys a test flow and checks the
// worker-function node in it. The method is the same as in the node-red-utils tests.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const vm = require('vm');
const { spawn } = require('child_process');

const REPO = path.resolve(__dirname, '..');

// The default code of a new node, from the editor file
const SKELETON = vm.runInNewContext(fs.readFileSync(path.join(REPO, 'worker-function.html'), 'utf8')
    .match(/const SKELETON = (\[[\s\S]*?\])\.join\('\\n'\);/)[1]).join('\n');

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

// The code of each worker-function node under test
const CODE = {
    echo: `worker.parentPorts.subscribe('input', (msg) => {
        msg.payload = msg.payload * 2;
        worker.parentPorts.publish('send', msg);
    });`,
    split: `worker.parentPorts.subscribe('input', (msg) => {
        worker.parentPorts.publish('send', [{ payload: 'one' }, { payload: 'two' }]);
    });`,
    report: `worker.parentPorts.subscribe('input', (msg) => {
        worker.parentPorts.publish('status', { fill: 'green', shape: 'dot', text: 'status from worker' });
        worker.parentPorts.publish('warn', 'warn from worker');
        worker.parentPorts.publish('error', { message: 'error from worker', msg });
    });`,
    context: `worker.parentPorts.subscribe('input', async (msg) => {
        await flow.set('f', 1);
        await global.set('g', 2);
        await context.set('c', 3);
        msg.payload = [await flow.get('f'), await global.get('g'), await context.get('c'),
            await context.keys(), await env.get('WF_TAB_ENV'), testMod.answer, path.basename('/a/b.txt'), await flow.get(['f'])];
        worker.parentPorts.publish('send', msg);
    });`,
    stageA: `worker.parentPorts.subscribe('input', (msg) => worker.outputPorts.publish('input', msg));`,
    stageB: `worker.inputPorts.subscribe('input', (msg, senderTrace) => {
        msg.via = senderTrace.nodeId;
        worker.parentPorts.publish('send', msg);
    });`,
    clone: `worker.parentPorts.subscribe('input', () => {});`,
    levels: `worker.parentPorts.subscribe('input', () => {
        for (const level of ['log', 'debug', 'trace']) worker.parentPorts.publish(level, level + ' from worker');
    });`,
    scope: `worker.parentPorts.subscribe('input', (msg) => {
        msg.payload = {
            path: node.path,
            sameStores: context.flow === flow && context.global === global,
            format: util.format('%s-%d', 'a', 1),
            prop: RED.util.getMessageProperty({ a: { b: 5 } }, 'a.b'),
            clone: RED.util.cloneMessage({ list: [1] }),
            helpers: Object.keys(RED.util).length
        };
        worker.parentPorts.publish('send', msg);
    });`,
    handler: `worker.parentPorts.subscribe('input', (msg) => {
        if (msg.payload === 1) null.x;
        worker.parentPorts.publish('send', msg);
    });`,
    async: `worker.parentPorts.subscribe('input', (msg) => {
        setTimeout(() => { throw new Error('timer boom'); });
        Promise.reject(new Error('rejected boom'));
        setTimeout(() => worker.parentPorts.publish('send', msg), 100);
    });`,
    linkcall: `worker.parentPorts.subscribe('input', async (msg) => {
        const byName = await node.linkcall('double', { payload: msg.payload });
        const byId = await node.linkcall('link-in', { payload: byName.payload });
        const missing = await node.linkcall('nothing', {}).catch((err) => err.message);
        msg.payload = [byName.payload, byId.payload, missing];
        worker.parentPorts.publish('send', msg);
    });`,
    baddata: `worker.parentPorts.subscribe('input', (msg) => {
        const out = worker.parentPorts;
        if (msg.payload === 1) out.publish('send', 'text');
        else if (msg.payload === 2) out.publish('send', [{ payload: 'x' }, 5]);
        else if (msg.payload === 3) out.publish('send', [[{ payload: 'ok' }], null]);
        else if (msg.payload === 5) out.publish('status', null);
        else out.publish('error', null);
    });`,
    busy: `worker.parentPorts.subscribe('input', () => {
        const end = Date.now() + 2500;
        while (Date.now() < end);
    });`,
    transfer: `worker.parentPorts.subscribe('input', (msg) => {
        worker.parentPorts.publish('send', { payload: [msg.payload.constructor.name, msg.payload.byteLength, msg.payload[0]] });
    });`,
    linkclose: `let call;
    worker.parentPorts.subscribe('input', () => { call = node.linkcall('hang', {}, { timeout: 4000 }).catch((err) => err.message); });
    worker.parentPorts.subscribe('close', async () => worker.parentPorts.publish('log', 'linkcall ended: ' + await call));`,
    syntax: 'this is not JavaScript (',
    syntaxTab: '\tthis is not JavaScript (',
    reject: `throw new Error('top level throw');`
};

const wf = (id, code, wires, extra = {}) => ({ id, type: 'worker-function', z: 'tab', name: id + ' node', func: code in CODE ? CODE[code] : code, outputs: wires.length, libs: [], wires, ...extra });
const inject = (id, payload, wires, type = 'num') => ({ id, type: 'inject', z: 'tab', props: [{ p: 'payload' }], payload: String(payload), payloadType: type, repeat: '', once: false, wires: [wires] });
// Stores each message it gets in the global context under its key
const collect = (key) => ({ id: 'collect-' + key, type: 'function', z: 'tab', outputs: 0, wires: [],
    func: `global.set(${JSON.stringify(key)}, (global.get(${JSON.stringify(key)}) || []).concat([msg]));` });

const FLOW = [
    { id: 'tab', type: 'tab', label: 'test', env: [{ name: 'WF_TAB_ENV', value: 'tab env value', type: 'str' }] },
    inject('i-echo', 21, ['echo']), wf('echo', 'echo', [['collect-echo']]), collect('echo'),
    inject('i-split', 0, ['split']), wf('split', 'split', [['collect-out1'], ['collect-out2']]), collect('out1'), collect('out2'),
    inject('i-report', 0, ['report']), wf('report', 'report', [[]]),
    { id: 'status-report', type: 'status', z: 'tab', scope: ['report'], wires: [['collect-status']] }, collect('status'),
    { id: 'status-all', type: 'status', z: 'tab', scope: null, wires: [['collect-allstatus']] }, collect('allstatus'),
    { id: 'catch-report', type: 'catch', z: 'tab', scope: ['report', 'reject'], uncaught: false, wires: [['collect-catch']] }, collect('catch'),
    inject('i-context', 0, ['context']),
    wf('context', 'context', [['collect-context']], { libs: [{ var: 'testMod', module: 'wf-test-mod' }, { var: 'path', module: 'path' }] }),
    collect('context'),
    inject('i-stage', 7, ['stageA']), wf('stageA', 'stageA', [['stageB']]), wf('stageB', 'stageB', [['collect-stage']]), collect('stage'),
    { id: 'http-clone', type: 'http in', z: 'tab', url: '/clone', method: 'post', wires: [['clone']] },
    wf('clone', 'clone', [[]]),
    { id: 'catch-clone', type: 'catch', z: 'tab', scope: ['clone'], uncaught: false, wires: [['clone-answer']] },
    { id: 'clone-answer', type: 'function', z: 'tab', outputs: 1, wires: [['clone-response']], func: 'msg.payload = msg.error.message; return msg;' },
    { id: 'clone-response', type: 'http response', z: 'tab', wires: [] },
    wf('syntax', 'syntax', [[]]), inject('i-syntax', 0, ['syntax']),
    { id: 'status-syntax', type: 'status', z: 'tab', scope: ['syntax'], wires: [['collect-syntax']] }, collect('syntax'),
    wf('syntaxTab', 'syntaxTab', [[]]),
    wf('reject', 'reject', [[]]),
    inject('i-levels', 0, ['levels']), wf('levels', 'levels', [[]]),
    inject('i-scope', 0, ['scope']), wf('scope', 'scope', [['collect-scope']]), collect('scope'),
    inject('i-handler-1', 1, ['handler']), inject('i-handler-2', 2, ['handler']),
    wf('handler', 'handler', [['collect-handler']]), collect('handler'),
    inject('i-async', 3, ['async']), wf('async', 'async', [['collect-async']]), collect('async'),
    { id: 'catch-more', type: 'catch', z: 'tab', scope: ['handler', 'async', 'baddata'], uncaught: false, wires: [['collect-catch']] },
    inject('i-linkcall', 4, ['linkcall']), wf('linkcall', 'linkcall', [['collect-linkcall']]), collect('linkcall'),
    { id: 'link-in', type: 'link in', z: 'tab', name: 'double', links: [], wires: [['link-double']] },
    { id: 'link-double', type: 'function', z: 'tab', outputs: 1, wires: [['link-return']], func: 'msg.payload *= 2; return msg;' },
    { id: 'link-return', type: 'link out', z: 'tab', mode: 'return', links: [], wires: [] },
    { id: 'link-hang', type: 'link in', z: 'tab', name: 'hang', links: [], wires: [[]] },
    inject('i-linkclose', 0, ['linkclose']), wf('linkclose', 'linkclose', [[]]),
    { id: 'status-linkclose', type: 'status', z: 'tab', scope: null, wires: [['collect-allstatus']] },
    inject('i-default', 5, ['default']), wf('default', SKELETON, [['collect-default']]), collect('default'),
    ...[1, 2, 3, 4, 5].map((n) => inject('i-bad-' + n, n, ['baddata'])), wf('baddata', 'baddata', [['collect-baddata']]), collect('baddata'),
    inject('i-busy', 0, ['busy']), wf('busy', 'busy', [[]]),
    { id: 'status-busy', type: 'status', z: 'tab', scope: ['busy'], wires: [['collect-busystatus']] }, collect('busystatus'),
    // Sends a pooled small Buffer or a large one, and later stores the length that the sender sees
    // 'part' sends a view on a part of a large ArrayBuffer and later stores the length of that ArrayBuffer
    ...['small', 'big', 'part'].map((size) => inject('i-' + size, size, ['make-' + size], 'str')),
    ...['small', 'big', 'part'].map((size) => ({ id: 'make-' + size, type: 'function', z: 'tab', outputs: 1, wires: [['xfer']],
        func: `const parent = ${size === 'small' ? "Buffer.from('abc')" : 'Buffer.alloc(1 << 20, 7)'};
            msg.payload = ${size === 'part' ? 'parent.subarray(10, 20)' : 'parent'};
            setTimeout(() => global.set('sent${size}', [parent.byteLength]), 300);
            return msg;` })),
    wf('xfer', 'transfer', [['collect-xfer']], { transfer: true }), collect('xfer'), collect('sentsmall'), collect('sentbig'), collect('sentpart'),
    // GET /results/<key> answers with the messages that collect(key) stored
    { id: 'http-results', type: 'http in', z: 'tab', url: '/results/:key', method: 'get', wires: [['results']] },
    { id: 'results', type: 'function', z: 'tab', outputs: 1, wires: [['results-response']],
        func: 'msg.payload = global.get(msg.req.params.key) || []; return msg;' },
    { id: 'results-response', type: 'http response', z: 'tab', wires: [] }
];

describe('worker-function in a real Node-RED', { timeout: 60000 }, () => {
    let child, base, userDir;
    let log = '';

    const results = (key, count = 1) => waitFor(async () => {
        const list = await (await fetch(`${base}/results/${key}`)).json();
        return list.length >= count && list;
    }, 5000, 'results of ' + key);
    const caughtFrom = (id, count = 1) => waitFor(async () => {
        const list = (await results('catch')).filter((m) => m.error.source.id === id);
        return list.length >= count && (count === 1 ? list[0] : list);
    }, 5000, 'catch of ' + id);
    const injectNode = (id) => fetch(`${base}/inject/${id}`, { method: 'POST' }).then((res) => assert.equal(res.status, 200));

    before(async () => {
        userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nrutils-nodes-test-'));
        // The package, as npm install puts it in the user dir
        fs.mkdirSync(path.join(userDir, 'node_modules', '@nrutils'), { recursive: true });
        fs.symlinkSync(REPO, path.join(userDir, 'node_modules', '@nrutils', 'node-red-worker-function'));
        // A module for the Modules list, where Node-RED installs such modules
        fs.mkdirSync(path.join(userDir, 'node_modules', 'wf-test-mod'));
        fs.writeFileSync(path.join(userDir, 'node_modules', 'wf-test-mod', 'index.js'), 'module.exports = { answer: 42 };');
        fs.writeFileSync(path.join(userDir, 'package.json'), JSON.stringify({ name: 'test', dependencies: { 'wf-test-mod': '1.0.0' } }));

        const port = await freePort();
        base = `http://127.0.0.1:${port}`;
        fs.writeFileSync(path.join(userDir, 'settings.js'), `module.exports = {
            uiHost: '127.0.0.1', uiPort: ${port}, flowFile: 'flows.json', credentialSecret: false,
            logging: { console: { level: 'trace' } }, diagnostics: { enabled: false }, telemetry: { enabled: false }
        };`);
        child = spawn(process.execPath, [require.resolve('node-red/red.js'), '-u', userDir, '-s', path.join(userDir, 'settings.js')],
            { stdio: ['ignore', 'pipe', 'pipe'] });
        child.stdout.on('data', d => { log += d; });
        child.stderr.on('data', d => { log += d; });
        await waitFor(async () => (await fetch(base + '/settings')).ok, 30000, 'Node-RED start');
        const res = await fetch(base + '/flows', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(FLOW) });
        assert.equal(res.status, 204, await res.text());
        // Node-RED answers the deploy before the flow runs: wait for the results route
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

    it('a flow message reaches the code and send comes out', async () => {
        await injectNode('i-echo');
        const [msg] = await results('echo');
        assert.equal(msg.payload, 42);
    });

    it('an array send goes to two outputs', async () => {
        await injectNode('i-split');
        assert.equal((await results('out1'))[0].payload, 'one');
        assert.equal((await results('out2'))[0].payload, 'two');
    });

    it('status, warn and error reach the node; a Catch node gets the error with the msg', async () => {
        await injectNode('i-report');
        assert.equal((await results('status'))[0].status.text, 'status from worker');
        const caught = await caughtFrom('report');
        assert.equal(caught.error.message, 'error from worker');
        assert.equal(caught.payload, 0, 'the Catch node gets the input msg');
        await waitFor(async () => log.includes('warn from worker'), 5000, 'warn in the log');
        // The status of the code stops the automatic busy or idle status
        await sleep(1500);
        const list = await results('status');
        assert.equal(list[list.length - 1].status.text, 'status from worker');
    });

    it('flow, global and node context set then get, env.get, and the Modules list', async () => {
        await injectNode('i-context');
        const [msg] = await results('context');
        assert.deepEqual(msg.payload, [1, 2, 3, ['c'], 'tab env value', 42, 'b.txt', [1]]);
    });

    it('two wired nodes pass a message thread to thread, and the second sends it to the flow', async () => {
        await injectNode('i-stage');
        const [msg] = await results('stage');
        assert.equal(msg.payload, 7);
        assert.equal(msg.via, 'stageA');
    });

    it('a msg that cannot be cloned gives done(err)', async () => {
        const res = await fetch(base + '/clone', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        assert.match(await res.text(), /could not be cloned|DataCloneError/);
    });

    it('a throw at the top level of the code is a node error that a Catch node gets', async () => {
        const caught = await caughtFrom('reject');
        assert.equal(caught.error.message, 'top level throw (line 1, col 7)');
    });

    it('a syntax error shows the worker error status and Node-RED keeps running', async () => {
        const [msg] = await results('syntax');
        assert.equal(msg.status.text, 'worker error');
        await waitFor(async () => /Worker error: .*Unexpected identifier 'is' \(line 1, col 6\)/.test(log), 5000, 'syntax error position in the log');
        // The automatic status stops with the worker, so it does not replace this one
        await sleep(1500);
        const list = await results('syntax');
        assert.equal(list[list.length - 1].status.text, 'worker error');
        await injectNode('i-echo');
        assert.equal((await results('echo', 2))[1].payload, 42);
    });

    it('a syntax error in code with tabs shows the column of the caret', async () => {
        await waitFor(async () => /Worker error: .*Unexpected identifier 'is' \(line 1, col 7\)/.test(log), 5000, 'syntax error position with a tab');
    });

    it('a message for a stopped worker gives a node error', async () => {
        // No Catch node for this node, so Node-RED logs the error
        await injectNode('i-syntax');
        await waitFor(async () => log.includes('the worker is stopped. A full deploy starts it again.'), 5000, 'stopped worker error in the log');
    });

    it('the default code passes a message through', async () => {
        await injectNode('i-default');
        assert.equal((await results('default'))[0].payload, 5);
    });

    it('send and error with bad data give node errors, and send sends nothing', async () => {
        for (const n of [1, 2, 3, 4, 5]) await injectNode('i-bad-' + n);
        const caught = await caughtFrom('baddata', 4);
        assert.deepEqual(caught.map((m) => m.error.message).sort(), [
            "the 'error' data must be a text or { message, msg }; got null",
            "the 'send' data must be a message object; got number",
            "the 'send' data must be a message object; got string",
            "the 'status' data must be an object or a string; got null"]);
        await sleep(300);
        assert.deepEqual((await results('baddata')).map((m) => m.payload), ['ok']);
    });

    it('a busy loop shows busy, then idle, as the node status', async () => {
        await injectNode('i-busy');
        const texts = async () => (await results('busystatus')).map((m) => m.status.text);
        // The number is a multiple of 10, so that the text stays the same while the load changes a little
        await waitFor(async () => (await texts()).some((t) => /^busy \d+0 %$/.test(t)), 8000, 'busy status');
        assert.ok((await texts()).every((t) => t === 'idle' || /^busy \d+0 %$/.test(t)));
        await waitFor(async () => {
            const list = await texts();
            return list.findIndex((t) => /^busy/.test(t)) < list.lastIndexOf('idle');
        }, 8000, 'idle after busy');
    });

    it('the option moves a whole large buffer; a small pooled Buffer and a part of a buffer go as a copy', async () => {
        for (const size of ['small', 'big', 'part']) await injectNode('i-' + size);
        const list = await results('xfer', 3);
        assert.deepEqual(list.map((m) => m.payload).sort(), [['Uint8Array', 1 << 20, 7], ['Uint8Array', 10, 7], ['Uint8Array', 3, 97]].sort());
        assert.deepEqual(await results('sentsmall'), [3], 'the copy leaves the small Buffer whole');
        assert.deepEqual(await results('sentbig'), [0], 'the move leaves the large buffer empty');
        assert.deepEqual(await results('sentpart'), [1 << 20], 'the copy leaves the parent buffer whole');
    });

    it('a throw in a subscribe handler goes to a Catch node with its position, and the worker keeps running', async () => {
        await injectNode('i-handler-1');
        const caught = await caughtFrom('handler');
        assert.equal(caught.error.message, "Cannot read properties of null (reading 'x') (line 2, col 37)");
        assert.equal(caught.payload, 1, 'the Catch node gets the input msg');
        await injectNode('i-handler-2');
        assert.equal((await results('handler'))[0].payload, 2);
    });

    it('a throw in a timer and an unhandled rejection go to a Catch node, and the worker keeps running', async () => {
        await injectNode('i-async');
        const messages = (await caughtFrom('async', 2)).map((m) => m.error.message).sort();
        assert.deepEqual(messages, ['rejected boom (line 3, col 24)', 'timer boom (line 2, col 34)']);
        assert.equal((await results('async'))[0].payload, 3);
    });

    it('log, debug and trace reach the log of Node-RED', async () => {
        await injectNode('i-levels');
        for (const level of ['log', 'debug', 'trace']) {
            await waitFor(async () => log.includes(level + ' from worker'), 5000, level + ' in the log');
        }
    });

    it('node.path, context.flow, context.global, util and RED.util are in scope', async () => {
        await injectNode('i-scope');
        const [msg] = await results('scope');
        assert.deepEqual(msg.payload, { path: 'tab/scope', sameStores: true, format: 'a-1', prop: 5, clone: { list: [1] }, helpers: 13 });
    });

    it('node.linkcall calls a link in node by name and by id, and rejects for an unknown target', async () => {
        await injectNode('i-linkcall');
        const [msg] = await results('linkcall');
        assert.deepEqual(msg.payload, [8, 16, "target link-in node 'nothing' not found"]);
    });

    // The last tests deploy again
    const redeploy = async (id) => {
        const changed = FLOW.map((n) => n.id === id ? { ...n, name: id + ' changed' } : n);
        const res = await fetch(base + '/flows', { method: 'POST', body: JSON.stringify(changed),
            headers: { 'Content-Type': 'application/json', 'Node-RED-Deployment-Type': 'nodes' } });
        assert.equal(res.status, 204, await res.text());
        // A Status node with a scope stops with the changed node, so this one has no scope
        await waitFor(async () => (await results('allstatus')).find((m) => m.status.source.id === id && !m.status.text),
            5000, 'empty status of the closed node');
    };

    it('the node clears the status that the code set when it closes', async () => {
        await results('status');
        await redeploy('report');
    });

    it('the node clears the automatic status, and a call of node.linkcall ends when the node closes', async () => {
        await injectNode('i-linkclose');
        await waitFor(async () => (await results('allstatus')).find((m) => m.status.source.id === 'linkclose' && m.status.text === 'idle'),
            5000, 'automatic status');
        const start = Date.now();
        await redeploy('linkclose');
        await waitFor(async () => log.includes('linkcall ended: node.linkcall: the node closed'), 1500, 'the call ends at close');
        assert.ok(Date.now() - start < 1900, 'the close handler does not wait for the limit of 2 s');
    });
});
