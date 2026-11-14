/**
 * Copyright 2026 UpDownMe733
 * Licensed under the Apache License, Version 2.0
 * http://www.apache.org/licenses/LICENSE-2.0
 */

'use strict';

// The agent-watch node: a short running commentary of the claude-agent nodes on its tab.
// It gets their events from the claude-agent package, a peer dependency, so that both use one event emitter.

const { NodeRedNodeBase, nodeRedPopup, nodeRedEditorComms } = require('@nrutils/node-red-utils');
const { events, agentSettings, loadSdk, weightedCount } = require('@nrutils/node-red-claude-agent/shared');

const MAX_LINES = 300;
const NARRATOR_MS = 30000;
const MAX_NEW_EVENTS = 12;      // for each stage in one narrator call; the newest stay
const EVENT_TEXT = 200;
const STATUS_TEXT = 60;
const NARRATED_KINDS = new Set(['text', 'tool', 'tool_result']);
const SYSTEM_PROMPT = 'You write a short running commentary on the work of AI agents for a human who watches. ' +
    'You get the stages that did something new. For each stage you get its last commentary line and its new events. ' +
    'Write at most one line for each stage. A line has at most 15 words. Use the present tense and plain words. ' +
    'Say what the agent does and for what purpose. Do not name tools. Do not repeat the last line of the stage. ' +
    'If a stage has nothing new to say, write no line for it. ' +
    'Answer only with lines in this form: <stage number>: <line>';

function cut(text, size) {
    const s = String(text).replace(/\s+/g, ' ').trim();
    return s.length > size ? s.slice(0, size) + '...' : s;
}

module.exports = NodeRedNodeBase.createNode('agent-watch', [nodeRedPopup, nodeRedEditorComms], (RED, node, config) => {
    const comms = node.nodeRedEditorComms;
    const settings = agentSettings(RED);
    const lines = [];               // the last MAX_LINES lines: { time, stage, text, level }
    const active = new Map();       // runId to { stage, waiting }
    const pending = new Map();      // stage to the new events that the narrator has not seen
    let totalWeighted = 0;          // the weighted tokens (sonnet input tokens) of the same runs and narrator calls
    let totalCost = 0;              // the cost in USD, as the API reports it, of all finished runs and narrator calls
    let errorShown = false;         // the newest line is an error
    let busy = false;               // a narrator call is open
    let warned = false;
    let abort = null;
    let timer = null;

    function showStatus() {
        const last = lines[lines.length - 1];
        const waiting = [...active.values()].some((r) => r.waiting);
        const fill = errorShown ? 'red' : waiting ? 'yellow' : active.size ? 'blue' : 'grey';
        const text = last ? `${last.stage}: ${cut(last.text, STATUS_TEXT)}` : 'no lines yet';
        node.status({ fill, shape: fill === 'grey' ? 'ring' : 'dot', text });
    }

    function addLine(stage, text, level) {
        const line = { time: Date.now(), stage, text, level };
        lines.push(line);
        if (lines.length > MAX_LINES) lines.shift();
        errorShown = level === 'error';
        comms.publish('line', line);
        showStatus();
    }

    function addCost(n, weighted) {
        if (!(n > 0) && !(weighted > 0)) return;
        if (n > 0) totalCost += n;
        if (weighted > 0) totalWeighted += weighted;
        comms.publish('total', { total: totalCost, weighted: totalWeighted });
    }

    function stageActive(stage) {
        return [...active.values()].some((r) => r.stage === stage);
    }

    function endRun(e) {
        active.delete(e.runId);
        if (!stageActive(e.stage)) pending.delete(e.stage);
    }

    function onEvent(e) {
        if (e.z !== node.z) return;
        const { stage, runId } = e;
        if (e.kind === 'state' && e.text === 'starting') {
            active.set(runId, { stage, waiting: false });
            addLine(stage, 'Started.', 'info');
        } else if (e.kind === 'result') {
            endRun(e);
            addLine(stage, `Done. ${e.turns} turns, ${e.tokens}.`, 'info');
            addCost(e.costUsd, e.weightedCount);
        } else if (e.kind === 'error') {
            endRun(e);
            addLine(stage, `FAILED: ${e.reason}.`, 'error');
            addCost(e.costUsd, e.weightedCount);
        } else if (e.kind === 'state' && e.text === 'stopped') {
            endRun(e);
            addLine(stage, 'Stopped by the operator.', 'info');
            addCost(e.costUsd, e.weightedCount);
        } else if (e.kind === 'question') {
            if (active.has(runId)) active.get(runId).waiting = true;
            addLine(stage, `WAITS: question to the operator: ${cut(e.text, 120)}`, 'wait');
        } else if (e.kind === 'answer') {
            if (active.has(runId)) active.get(runId).waiting = false;
            addLine(stage, 'Operator answered.', 'info');
        } else if (NARRATED_KINDS.has(e.kind)) {
            const list = pending.get(stage) || [];
            list.push({ kind: e.kind, text: cut(e.text, EVENT_TEXT) });
            if (list.length > MAX_NEW_EVENTS) list.shift();
            pending.set(stage, list);
        }
    }

    function lastLine(stage) {
        for (let i = lines.length - 1; i >= 0; i--) if (lines[i].stage === stage) return lines[i].text;
        return 'none';
    }

    async function narrate() {
        if (busy || !pending.size) return;
        const stages = [...pending.keys()];
        const prompt = stages.map((stage, i) => `Stage ${i + 1}: ${stage}\nLast line: ${lastLine(stage)}\nNew events:\n` +
            pending.get(stage).map((ev) => `- ${ev.kind}: ${ev.text}`).join('\n')).join('\n\n');
        pending.clear();
        busy = true;
        abort = new AbortController();
        try {
            const sdk = await loadSdk();
            const options = {
                pathToClaudeCodeExecutable: settings.launcher,
                cwd: settings.workRoot,
                model: 'haiku',
                maxTurns: 1,
                thinking: { type: 'disabled' },
                effort: 'low',
                systemPrompt: SYSTEM_PROMPT,
                tools: [],
                mcpServers: {},
                strictMcpConfig: true,
                settingSources: [],
                skills: [],
                settings: { autoMemoryEnabled: false },
                persistSession: false,
                permissionMode: 'bypassPermissions',
                allowDangerouslySkipPermissions: true,
                abortController: abort
            };
            let result;
            for await (const m of sdk.query({ prompt, options })) if (m.type === 'result') result = m;
            if (!result || result.is_error) throw new Error((result && result.result) || 'no result');
            const u = result.usage || {};
            addCost(result.total_cost_usd, weightedCount(result.modelUsage));
            node.log(`narrator: input ${u.input_tokens}, cache read ${u.cache_read_input_tokens}, ` +
                `cache write ${u.cache_creation_input_tokens}, output ${u.output_tokens}`);
            for (const row of String(result.result).split('\n')) {
                const m = /^\s*(?:Stage\s*)?(\d+)\s*[:.)-]\s*(.+?)\s*$/i.exec(row);
                const stage = m && stages[Number(m[1]) - 1];
                // A stage that has ended already has its Done line: no narrator line after it.
                if (stage && stageActive(stage)) addLine(stage, m[2], 'info');
            }
        } catch (err) {
            if (!warned && abort && !abort.signal.aborted) {
                warned = true;
                node.warn(`The narrator failed. The node gives only the free lines. ${err.message}`);
            }
        } finally {
            busy = false;
        }
    }

    events.on('event', onEvent);
    // A message on the input is a result of the flow: one line, msg.topic as the stage and msg.payload as the text.
    node.on('input', (msg, send, done) => {
        const p = msg.payload;
        addLine(msg.topic ? String(msg.topic) : 'Result', typeof p === 'string' ? p : JSON.stringify(p, null, 2), 'result');
        done();
    });
    if (config.narrator !== false) timer = setInterval(narrate, NARRATOR_MS);
    showStatus();

    node.on('close', () => {
        events.off('event', onEvent);
        clearInterval(timer);
        if (abort) abort.abort();
    });

    // The popup asks for the kept lines when it opens.
    comms.subscribe('get-log', () => ({ lines, total: totalCost, weighted: totalWeighted }));
});
