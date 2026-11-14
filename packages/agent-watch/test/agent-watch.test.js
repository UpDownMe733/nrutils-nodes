'use strict';

// Starts one real Node-RED in a scratch user dir with the agent-watch and claude-agent packages,
// deploys a test flow and checks the lines of the agent-watch node. The launcher in settings.js is the
// fake CLI of the claude-agent tests: the tests do not call the Claude service.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const CLAUDE_AGENT = path.dirname(require.resolve('@nrutils/node-red-claude-agent/package.json'));
const FAKE = path.join(CLAUDE_AGENT, 'test', 'fixtures', 'fake-claude.js');

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
const agent = (id, z, wires) => ({ id, type: 'claude-agent', z, name: id + ' stage', prompt: '{{payload}}', cwd: '', sandbox: '',
    tools: '', maxTurns: 30, maxCostUsd: 2, timeoutMin: 30, maxParallel: 1, outputSchema: '', mcpServers: '', wires });
const inject = (id, z, payload, wires, topic = '') => ({ id, type: 'inject', z, repeat: '', once: false, wires: [wires],
    props: [{ p: 'payload' }, { p: 'topic', vt: 'str' }], payload, payloadType: 'str', topic });

const FLOW = [
    { id: 'tab', type: 'tab', label: 'test' },
    { id: 'watch', type: 'agent-watch', z: 'tab', name: '', narrator: false, wires: [] },
    inject('i-done', 'tab', 'hello', ['done']), agent('done', 'tab', [[], [], []]),
    inject('i-fail', 'tab', 'maxturns', ['fail']), agent('fail', 'tab', [[], [], []]),
    inject('i-ask', 'tab', 'ask Go on?', ['ask']), agent('ask', 'tab', [[], ['answer'], []]),
    { id: 'answer', type: 'function', z: 'tab', outputs: 1, wires: [['ask']],
        func: 'return { payload: "yes", agent: { cmd: "answer", runId: msg.agent.runId } };' },
    inject('i-result', 'tab', 'all good', ['watch'], 'Report'),
    // A second tab: its watch node does not see the agents of the first tab
    { id: 'tab2', type: 'tab', label: 'other' },
    { id: 'watch2', type: 'agent-watch', z: 'tab2', name: '', narrator: false, wires: [] },
    // Three tabs with the narrator on: an active stage, a stage that ends during the narrator call
    // and a narrator call that fails. A Catch node gives each error on its tab to the watch node as a line.
    { id: 'tab3', type: 'tab', label: 'narrator' },
    { id: 'watch3', type: 'agent-watch', z: 'tab3', name: '', narrator: true, wires: [] },
    inject('i-busy', 'tab3', 'wait', ['busy']), agent('busy', 'tab3', [[], [], []]),
    { id: 'tab4', type: 'tab', label: 'narrator late' },
    { id: 'watch4', type: 'agent-watch', z: 'tab4', name: '', narrator: true, wires: [] },
    inject('i-late', 'tab4', 'slowdone', ['late']), agent('late', 'tab4', [[], [], []]),
    { id: 'tab5', type: 'tab', label: 'narrator fails' },
    { id: 'watch5', type: 'agent-watch', z: 'tab5', name: '', narrator: true, wires: [] },
    inject('i-broken1', 'tab5', 'wait narratorfail', ['broken1']), agent('broken1', 'tab5', [[], [], []]),
    inject('i-broken2', 'tab5', 'wait narratorfail', ['broken2']), agent('broken2', 'tab5', [[], [], []]),
    { id: 'catch5', type: 'catch', z: 'tab5', name: '', scope: null, uncaught: false, wires: [['watch5']] }
];
const NARRATOR_LINE = 'The agent works on its task.';

describe('agent-watch in a real Node-RED', { timeout: 60000 }, () => {
    let child, base, userDir;
    let log = '';

    const injectNode = (id) => fetch(`${base}/inject/${id}`, { method: 'POST' }).then((res) => assert.equal(res.status, 200));
    // The lines and totals that the popup gets when it opens
    const popup = async (nodeId) => {
        const res = await fetch(`${base}/node_red_editorcomms`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ nodeId, messageType: 'get-log' }) });
        return (await res.json()).result;
    };
    const lineOf = (stage, text, nodeId = 'watch') => waitFor(async () => (await popup(nodeId)).lines
        .find((l) => l.stage === stage && l.text === text), 10000, `line "${stage}: ${text}"`);
    // The first line of the prompt of each narrator call, as the fake CLI writes it
    const narratorCalls = () => {
        const file = path.join(userDir, 'narrator-calls.log');
        return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
    };

    before(async () => {
        userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nrutils-nodes-test-'));
        // The two packages, as npm install puts them in the user dir
        fs.mkdirSync(path.join(userDir, 'node_modules', '@nrutils'), { recursive: true });
        fs.symlinkSync(REPO, path.join(userDir, 'node_modules', '@nrutils', 'node-red-agent-watch'));
        fs.symlinkSync(CLAUDE_AGENT, path.join(userDir, 'node_modules', '@nrutils', 'node-red-claude-agent'));

        const port = await freePort();
        base = `http://127.0.0.1:${port}`;
        fs.writeFileSync(path.join(userDir, 'settings.js'), `module.exports = {
            uiHost: '127.0.0.1', uiPort: ${port}, flowFile: 'flows.json', credentialSecret: false,
            diagnostics: { enabled: false }, telemetry: { enabled: false },
            claudeAgent: { launcher: ${JSON.stringify(FAKE)}, workRoot: ${JSON.stringify(userDir)} },
            agentWatch: { narratorSeconds: 0.3 }
        };`);
        child = spawn(process.execPath, [require.resolve('node-red/red.js'), '-u', userDir, '-s', path.join(userDir, 'settings.js')],
            { stdio: ['ignore', 'pipe', 'pipe'] });
        child.stdout.on('data', d => { log += d; });
        child.stderr.on('data', d => { log += d; });
        await waitFor(async () => (await fetch(base + '/settings')).ok, 30000, 'Node-RED start');
        const res = await fetch(base + '/flows', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(FLOW) });
        assert.equal(res.status, 204, await res.text());
        await waitFor(async () => popup('watch'), 5000, 'flow start');
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

    it('Node-RED loads both node types with no error', () => {
        assert.doesNotMatch(log, /\[error\]|Waiting for missing types/);
    });

    it('a run of a claude-agent node on the tab gives the Started and Done lines and the totals', async () => {
        await injectNode('i-done');
        await lineOf('done stage', 'Started.');
        await lineOf('done stage', 'Done. 1 turns, 1.1k tokens.');
        const state = await popup('watch');
        assert.equal(state.total, 0.01);
        assert.equal(state.weighted, 1500, 'sonnet: 1000 + 100 * 5');
    });

    it('a failed run gives a FAILED line with the reason', async () => {
        await injectNode('i-fail');
        assert.equal((await lineOf('fail stage', 'FAILED: max_turns.')).level, 'error');
    });

    it('a question and its answer give the WAITS and Operator answered lines', async () => {
        await injectNode('i-ask');
        assert.equal((await lineOf('ask stage', 'WAITS: question to the operator: Go on?')).level, 'wait');
        await lineOf('ask stage', 'Operator answered.');
        await lineOf('ask stage', 'Done. 1 turns, 1.1k tokens.');
    });

    it('a message on the input gives a result line with msg.topic as the stage', async () => {
        await injectNode('i-result');
        assert.equal((await lineOf('Report', 'all good')).level, 'result');
    });

    it('a watch node on another tab gets no line of these runs', async () => {
        assert.deepEqual((await popup('watch2')).lines, []);
    });

    it('the narrator adds a line for an active stage and adds the cost of its call to the totals', async () => {
        await injectNode('i-busy');
        await lineOf('busy stage', 'Started.', 'watch3');
        assert.equal((await lineOf('busy stage', NARRATOR_LINE, 'watch3')).level, 'info');
        assert.ok(narratorCalls().includes('Stage 1: busy stage'));
        // The run has not ended: the totals are those of the narrator call, with the haiku model
        const state = await popup('watch3');
        assert.equal(state.total, 0.01);
        assert.ok(Math.abs(state.weighted - 75) < 1e-9, 'haiku: (1000 + 100 * 5) * 0.05, got ' + state.weighted);
    });

    it('the narrator adds no line for a stage that ended during its call', async () => {
        await injectNode('i-late');
        await lineOf('late stage', 'Done. 1 turns, 1.1k tokens.', 'watch4');
        // The run and the narrator call each cost 0.01: the call has returned when the total is 0.02
        await waitFor(async () => Math.abs((await popup('watch4')).total - 0.02) < 1e-9, 10000, 'the narrator call');
        assert.ok(narratorCalls().includes('Stage 1: late stage'));
        assert.deepEqual((await popup('watch4')).lines.map((l) => l.text), ['Started.', 'Done. 1 turns, 1.1k tokens.']);
    });

    it('failed narrator calls give one warning and no error to a Catch node', async () => {
        const warnings = () => (log.match(/The narrator failed/g) || []).length;
        await injectNode('i-broken1');
        await waitFor(async () => warnings() === 1, 10000, 'the warning');
        await injectNode('i-broken2');
        await waitFor(async () => narratorCalls().includes('Stage 1: broken2 stage'), 10000, 'the second narrator call');
        await sleep(1000);
        assert.equal(warnings(), 1);
        const state = await popup('watch5');
        assert.deepEqual(state.lines.map((l) => `${l.stage}: ${l.text}`), ['broken1 stage: Started.', 'broken2 stage: Started.']);
        assert.equal(state.total, 0);
    });
});
