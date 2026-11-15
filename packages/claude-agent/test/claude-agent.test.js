'use strict';

// Starts one real Node-RED in a scratch user dir, deploys a test flow and checks the
// claude-agent node in it. The launcher in settings.js is test/fixtures/fake-claude.js:
// the tests do not call the Claude service.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const FAKE = path.join(__dirname, 'fixtures', 'fake-claude.js');

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

// A node name that equals a node id makes Node-RED see a config node: the name is the id with " stage"
const agent = (id, wires, extra = {}) => ({ id, type: 'claude-agent', z: 'tab', name: id + ' stage', prompt: '{{payload}}', cwd: '', sandbox: '',
    tools: '', maxTurns: 30, maxCostUsd: 2, timeoutMin: 30, maxParallel: 1, outputSchema: '', mcpServers: '', wires, ...extra });
// An inject node with a payload text and more msg properties: { name: [value, type] }
const inject = (id, payload, wires, more = {}) => ({ id, type: 'inject', z: 'tab', repeat: '', once: false, wires: [wires],
    props: [{ p: 'payload' }, ...Object.entries(more).map(([p, [v, vt]]) => ({ p, v, vt }))], payload, payloadType: 'str' });
// Stores each message it gets in the global context under its key
const collect = (key) => ({ id: 'collect-' + key, type: 'function', z: 'tab', outputs: 0, wires: [],
    func: `global.set(${JSON.stringify(key)}, (global.get(${JSON.stringify(key)}) || []).concat([msg]));` });

function makeFlow(workRoot) {
    return [
        { id: 'tab', type: 'tab', label: 'test' },
        inject('i-run', 'hello', ['run'], { topic: ['greet', 'str'] }),
        agent('run', [['collect-result'], [], ['collect-events']], { prompt: 'Task: {{payload}} {{topic}}', model: 'haiku', cwd: path.join(workRoot, 'project') }),
        collect('result'), collect('events'),
        inject('i-sandbox', 'hello', ['sandbox']),
        inject('i-cache5m', 'hello', ['cache5m']), agent('cache5m', [['collect-cache5m'], [], []], { cacheTtl: '5m' }), collect('cache5m'),
        inject('i-cachebogus', 'hello', ['cachebogus']), agent('cachebogus', [['collect-cachebogus'], [], []], { cacheTtl: 'bogus' }), collect('cachebogus'),
        agent('sandbox', [['collect-sandbox'], [], []], { sandbox: 'box-1', cwd: path.join(workRoot, 'remote') }), collect('sandbox'),
        inject('i-badname', 'hello', ['badname']), agent('badname', [[], [], []], { sandbox: 'bad name' }),
        inject('i-outside', 'hello', ['outside'], { cwd: ['/', 'str'] }), agent('outside', [[], [], []]),
        inject('i-maxturns', 'maxturns', ['maxturns']), agent('maxturns', [[], [], []]),
        inject('i-nologin', 'nologin', ['nologin']), agent('nologin', [[], [], []]),
        // The question goes out on output 2, a function answers yes, the answer goes back in
        inject('i-ask', 'ask Deploy now?', ['ask']),
        agent('ask', [['collect-ask'], ['answer'], []]), collect('ask'),
        { id: 'answer', type: 'function', z: 'tab', outputs: 1, wires: [['ask', 'collect-question']],
            func: 'return { payload: "yes", agent: { cmd: "answer", runId: msg.agent.runId } };' }, collect('question'),
        inject('i-wait', 'wait', ['wait']), inject('i-stop', '', ['wait'], { agent: ['{"cmd":"stop"}', 'json'] }),
        agent('wait', [['collect-waitresult'], [], ['collect-waitevents']]), collect('waitresult'), collect('waitevents'),
        // maxParallel 1: a second start message waits in the queue
        inject('i-queue', 'wait', ['queue']), inject('i-queuestop', '', ['queue'], { agent: ['{"cmd":"stop"}', 'json'] }),
        agent('queue', [[], [], ['collect-queueevents']]), collect('queueevents'),
        { id: 'catch-all', type: 'catch', z: 'tab', scope: null, uncaught: false, wires: [['collect-catch']] }, collect('catch'),
        // GET /results/<key> answers with the messages that collect(key) stored
        { id: 'http-results', type: 'http in', z: 'tab', url: '/results/:key', method: 'get', wires: [['results']] },
        { id: 'results', type: 'function', z: 'tab', outputs: 1, wires: [['results-response']],
            func: 'msg.payload = global.get(msg.req.params.key) || []; return msg;' },
        { id: 'results-response', type: 'http response', z: 'tab', wires: [] }
    ];
}

describe('claude-agent in a real Node-RED', { timeout: 60000 }, () => {
    let child, base, userDir, workRoot;
    let log = '';

    const results = (key, count = 1) => waitFor(async () => {
        const list = await (await fetch(`${base}/results/${key}`)).json();
        return list.length >= count && list;
    }, 10000, 'results of ' + key);
    const caughtFrom = (id) => waitFor(async () => (await results('catch')).find((m) => m.error.source.id === id), 10000, 'catch of ' + id);
    const injectNode = (id) => fetch(`${base}/inject/${id}`, { method: 'POST' }).then((res) => assert.equal(res.status, 200));
    // A message from the popup of a node, as the editor sends it
    const editor = async (nodeId, messageType, payload) => {
        const res = await fetch(`${base}/node_red_editorcomms`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ nodeId, messageType, payload }) });
        return (await res.json()).result;
    };

    before(async () => {
        userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nrutils-nodes-test-'));
        workRoot = path.join(userDir, 'work');
        fs.mkdirSync(path.join(workRoot, 'project'), { recursive: true });
        // The package, as npm install puts it in the user dir
        fs.mkdirSync(path.join(userDir, 'node_modules', '@nrutils'), { recursive: true });
        fs.symlinkSync(REPO, path.join(userDir, 'node_modules', '@nrutils', 'node-red-claude-agent'));

        const port = await freePort();
        base = `http://127.0.0.1:${port}`;
        fs.writeFileSync(path.join(userDir, 'settings.js'), `module.exports = {
            uiHost: '127.0.0.1', uiPort: ${port}, flowFile: 'flows.json', credentialSecret: false,
            diagnostics: { enabled: false }, telemetry: { enabled: false },
            claudeAgent: { launcher: ${JSON.stringify(FAKE)}, workRoot: ${JSON.stringify(workRoot)}, sandboxPattern: '^box-[0-9]+$' }
        };`);
        child = spawn(process.execPath, [require.resolve('node-red/red.js'), '-u', userDir, '-s', path.join(userDir, 'settings.js')],
            { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, FORCE_PROMPT_CACHING_5M: '1', CLAUDE_CODE_PROMPT_CACHE_TTL: '5m', CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL: '5m' } });
        child.stdout.on('data', d => { log += d; });
        child.stderr.on('data', d => { log += d; });
        await waitFor(async () => (await fetch(base + '/settings')).ok, 30000, 'Node-RED start');
        const res = await fetch(base + '/flows', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(makeFlow(workRoot)) });
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

    it('Node-RED loads the node with no error', () => {
        assert.match(log, /Added node types|Starting flows/);
        assert.doesNotMatch(log, /\[error\]/);
    });

    it('a start message runs the launcher in the folder with the prompt, model and permission mode', async () => {
        await injectNode('i-run');
        const [msg] = await results('result');
        const got = JSON.parse(msg.payload);
        assert.equal(got.prompt, 'Task: hello greet');
        assert.equal(got.cwd, fs.realpathSync(path.join(workRoot, 'project')));
        assert.equal(got.model, 'haiku');
        assert.equal(got.permissionMode, 'bypassPermissions');
        assert.equal(got.sandbox, null);
        assert.equal(got.settings.promptCacheTtl, '1h', 'a node without cacheTtl gets 1 hour');
        assert.equal(got.settings.subagentPromptCacheTtl, '1h');
        assert.equal(got.settings.autoMemoryEnabled, false);
        assert.equal(msg.topic, 'greet', 'the result keeps the other properties of the start message');
        assert.equal(msg.stages['run stage'], msg.payload, 'the node name is the key in msg.stages');
        assert.equal(msg.agent.sessionId, 'fake-session');
        assert.equal(msg.agent.turns, 1);
        assert.equal(msg.agent.tokens, 1100);
        assert.equal(msg.agent.weighted, 75, 'haiku: (1000 + 100 * 5) * 0.05');
    });

    it('output 3 sends the events of the run', async () => {
        const kinds = (await waitFor(async () => {
            const list = await results('events');
            return list.some((m) => m.payload.kind === 'result') && list;
        }, 10000, 'result event')).map((m) => m.payload.kind);
        for (const kind of ['state', 'prompt', 'text', 'result']) assert.ok(kinds.includes(kind), kind + ' in ' + kinds);
        const [first] = await results('events');
        assert.match(first.topic, /^agent\/run\/[0-9a-f]{8}$/);
    });

    it('the popup log has the events, and Send in the popup starts a run in the last session', async () => {
        const state = await editor('run', 'get-log');
        assert.ok(state.events.some((e) => e.kind === 'result'));
        assert.deepEqual(state.runs, []);
        assert.deepEqual(await editor('run', 'start', { text: 'from the popup' }), {});
        const list = await results('result', 2);
        assert.equal(JSON.parse(list[0].payload).resume, null);
        assert.equal(JSON.parse(list[1].payload).prompt, 'from the popup');
        assert.equal(JSON.parse(list[1].payload).resume, 'fake-session');
        const after = await editor('run', 'get-log');
        assert.equal(after.session.cacheTtl, '1h');
        assert.equal(typeof after.session.lastActivity, 'number');
    });

    it('New chat clears the popup log and the session, and the next popup run starts a new session', async () => {
        assert.deepEqual(await editor('run', 'new-chat'), {});
        const state = await editor('run', 'get-log');
        assert.deepEqual(state.events, []);
        assert.deepEqual(state.session, { cacheTtl: '1h', lastActivity: null });
        assert.deepEqual(await editor('run', 'start', { text: 'fresh chat' }), {});
        const list = await results('result', 3);
        assert.equal(JSON.parse(list[2].payload).prompt, 'fresh chat');
        assert.equal(JSON.parse(list[2].payload).resume, null);
    });

    it('a sandbox run gives the sandbox name and the folder to the launcher in the environment', async () => {
        await injectNode('i-sandbox');
        const got = JSON.parse((await results('sandbox'))[0].payload);
        assert.equal(got.sandbox, 'box-1');
        assert.equal(got.sandboxCwd, path.join(workRoot, 'remote'));
        assert.equal(got.cwd, fs.realpathSync(workRoot), 'the launcher starts in the work root');
    });

    it('a node with the cache time 5m gives 5m for the main agent and the subagents', async () => {
        await injectNode('i-cache5m');
        const [msg] = await results('cache5m');
        const got = JSON.parse(msg.payload);
        assert.equal(got.settings.promptCacheTtl, '5m');
        assert.equal(got.settings.subagentPromptCacheTtl, '5m');
        assert.equal(got.settings.autoMemoryEnabled, false);
        assert.equal((await editor('cache5m', 'get-log')).session.cacheTtl, '5m');
    });

    it('an unknown cache time gives 1h', async () => {
        await injectNode('i-cachebogus');
        const got = JSON.parse((await results('cachebogus'))[0].payload);
        assert.equal(got.settings.promptCacheTtl, '1h');
        assert.equal(got.settings.subagentPromptCacheTtl, '1h');
    });

    it('the cache time variables of Node-RED do not reach the run', async () => {
        const [msg] = await results('result');
        const got = JSON.parse(msg.payload);
        assert.equal(got.forceCache5m, null);
        assert.equal(got.cacheTtlEnv, null);
        assert.equal(got.subagentCacheTtlEnv, null);
        assert.equal(got.settings.promptCacheTtl, '1h');
    });

    it('a sandbox name against the rule of settings.js fails the run', async () => {
        await injectNode('i-badname');
        assert.match((await caughtFrom('badname')).error.message, /the sandbox name "bad name" is not valid/);
    });

    it('a folder outside the work root fails the run', async () => {
        await injectNode('i-outside');
        assert.ok((await caughtFrom('outside')).error.message.endsWith(`the folder "/" is not in ${workRoot}`));
    });

    it('an error result of the SDK goes to a Catch node with the reason', async () => {
        await injectNode('i-maxturns');
        const caught = await caughtFrom('maxturns');
        assert.equal(caught.agent.reason, 'max_turns');
    });

    it('a run that fails before a model response does not start the cache countdown', async () => {
        await injectNode('i-nologin');
        assert.match((await caughtFrom('nologin')).error.message, /Not logged in/);
        assert.deepEqual((await editor('nologin', 'get-log')).session, { cacheTtl: '1h', lastActivity: null });
    });

    it('a question goes out on output 2 and an answer message continues the run', async () => {
        await injectNode('i-ask');
        const [answer] = await results('question');
        assert.equal(answer.agent.cmd, 'answer');
        const [msg] = await results('ask');
        assert.equal(msg.payload, 'The operator said: yes');
    });

    it('a stop message ends the run with the event stopped and no result', async () => {
        await injectNode('i-wait');
        await waitFor(async () => (await results('waitevents')).some((m) => m.payload.text === 'running'), 10000, 'running');
        await injectNode('i-stop');
        await waitFor(async () => (await results('waitevents')).some((m) => m.payload.text === 'stopped'), 10000, 'stopped');
        await sleep(300);
        assert.deepEqual(await (await fetch(`${base}/results/waitresult`)).json(), []);
    });

    it('the popup gets the start time and the last response of an active run, and New chat waits until the run ends', async () => {
        const count = (text) => results('waitevents').then((list) => list.filter((m) => m.payload.text === text).length);
        await injectNode('i-wait');
        await waitFor(async () => (await count('running')) >= 2, 10000, 'running');
        const state = await waitFor(async () => {
            const s = await editor('wait', 'get-log');
            return s.runs.length === 1 && s.runs[0].lastActivity && s;
        }, 10000, 'last activity');
        assert.equal(typeof state.runs[0].startTime, 'number');
        assert.ok(state.runs[0].lastActivity >= state.runs[0].startTime);
        assert.equal(state.session.lastActivity, state.runs[0].lastActivity);
        assert.deepEqual(await editor('wait', 'new-chat'), { error: 'stop the active run first' });
        const again = await editor('wait', 'get-log');
        assert.equal(again.events.length, state.events.length);
        assert.deepEqual(again.session, state.session);
        await injectNode('i-stop');
        await waitFor(async () => (await count('stopped')) >= 2, 10000, 'stopped');
    });

    it('New chat waits while a start message is in the queue', async () => {
        const count = (text) => results('queueevents').then((list) => list.filter((m) => m.payload.text === text).length);
        await injectNode('i-queue');
        await waitFor(async () => (await count('running')) >= 1, 10000, 'running');
        await injectNode('i-queue');
        const state = await waitFor(async () => {
            const s = await editor('queue', 'get-log');
            return s.runs.length === 1 && typeof s.session.lastActivity === 'number' && s;
        }, 10000, 'one run and one queued job');
        assert.deepEqual(await editor('queue', 'new-chat'), { error: 'stop the active run first' });
        const again = await editor('queue', 'get-log');
        assert.equal(again.events.length, state.events.length);
        assert.deepEqual(again.session, state.session);
        // The stop ends the first run. The queued job starts, and the second stop ends it.
        await injectNode('i-queuestop');
        await waitFor(async () => (await count('running')) >= 2, 10000, 'queued run');
        await injectNode('i-queuestop');
        await waitFor(async () => (await count('stopped')) >= 2, 10000, 'stopped');
    });

    it('the editor gets the claudeAgent settings for the Sandbox rule', async () => {
        const settings = await (await fetch(base + '/settings')).json();
        assert.equal(settings.claudeAgent.sandboxPattern, '^box-[0-9]+$');
    });
});
