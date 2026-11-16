/**
 * Copyright 2026 UpDownMe733
 * Licensed under the Apache License, Version 2.0
 * http://www.apache.org/licenses/LICENSE-2.0
 */

'use strict';

// The claude-agent node: each start message runs one Claude Code agent through the Claude Agent SDK.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mustache = require('mustache');
const z = require('zod');
const { NodeRedNodeBase, nodeRedPopup, nodeRedEditorComms } = require('@nrutils/node-red-utils');
const { events, agentSettings, loadSdk, weightedCount, weightedText } = require('./shared');

// The models that msg.model can choose. A different value uses the model of the node.
const MSG_MODELS = new Set(['haiku', 'sonnet', 'opus', 'fable']);
const LOG_SIZE = 200;
const TEXT_SIZE = 300;
const INTERRUPTED = ['aborted_streaming', 'aborted_tools'];
// The failure reason for each SDK error subtype. Other errors get "sdk_error".
const REASONS = {
    error_max_turns: 'max_turns',
    error_max_budget_usd: 'max_cost',
    error_max_structured_output_retries: 'schema'
};

// Event kinds that the popup chat view shows: the text of the operator and of the agent
const CHAT_KINDS = new Set(['prompt', 'message', 'answer', 'text', 'question']);

function cut(value) {
    const text = typeof value === 'string' ? value : JSON.stringify(value) || '';
    return text.length > TEXT_SIZE ? text.slice(0, TEXT_SIZE) + '...' : text;
}

function splitList(text) {
    return text ? String(text).split(',').map((s) => s.trim()).filter(Boolean) : [];
}

function failure(reason, message) {
    const err = new Error(message);
    err.reason = reason;
    return err;
}

// Give the real path of a work folder. Throw if it is not the work root or below it.
// A sandbox folder is not on this machine: only its path is checked.
function workFolder(folder, root, sandbox) {
    let real = '';
    try {
        real = sandbox ? path.posix.resolve('/', String(folder)) : fs.realpathSync(String(folder));
        if (!sandbox) root = fs.realpathSync(root);
    } catch {
        // A folder that does not exist fails the check below.
    }
    if (real === root || real.startsWith(root.replace(/\/$/, '') + '/')) return real;
    throw new Error(`the folder "${folder}" is not in ${root}`);
}

// The tokens of a run: all input (new and from the cache) plus output, for all models.
function tokenCount(modelUsage) {
    let n = 0;
    for (const u of Object.values(modelUsage || {})) n += u.inputTokens + u.cacheCreationInputTokens + u.cacheReadInputTokens + u.outputTokens;
    return n;
}
const costText = (usd) => `$${(Number.isFinite(usd) ? usd : 0).toFixed(2)}`;
const tokenText = (n) => `${n >= 1000 ? (n / 1000).toFixed(1) + 'k' : n || 0} tokens`;

module.exports = NodeRedNodeBase.createNode('claude-agent', [nodeRedPopup, nodeRedEditorComms], (RED, node, config) => {
    const comms = node.nodeRedEditorComms;
    const settings = agentSettings(RED);
    const maxParallel = Math.max(1, Number(config.maxParallel) || 1);
    const maxTurns = Number(config.maxTurns) || 30;
    // An empty field means no limit.
    const maxCostUsd = config.maxCostUsd === '' ? undefined : Number(config.maxCostUsd ?? 2);
    const timeoutMs = config.timeoutMin === '' ? 0 : Number(config.timeoutMin ?? 30) * 60000;
    // The cache time of the prompt cache: 5 minutes or 1 hour. A node without the property, or with another value, gets 1 hour.
    const cacheTtl = config.cacheTtl === '5m' ? '5m' : '1h';
    const stageKey = config.name || node.id;
    const runs = new Map();     // runId to run
    const queue = [];           // start messages that wait for a free slot: { msg, send, done, text }
    let lastSessionId;          // session of the newest run; the popup continues it
    let lastSessionCwd;         // folder of that session; the popup run uses it again
    let sessionActivity = null; // time of the last model response in that session; the popup counts down the cache from it
    const log = [];             // the last LOG_SIZE events of all runs, for a new popup
    let lastStatus = {};
    let closing = false;

    function runList() {
        return [...runs.values()].map((r) => ({
            runId: r.id, state: r.state, turns: r.turns, tokens: tokenText(r.tokens), question: r.question,
            startTime: r.startTime, lastActivity: r.lastActivity
        }));
    }

    // The session state of the popup: the cache time and the time of the last model response
    function session() {
        return { cacheTtl, lastActivity: sessionActivity };
    }

    // A model response of the run. The prompt cache lives for the cache time after it.
    function touch(run) {
        run.lastActivity = Date.now();
        if (run.sessionId && run.sessionId === lastSessionId) {
            sessionActivity = run.lastActivity;
            comms.publish('session', session());
        }
    }

    function showStatus() {
        if (!runs.size && !queue.length) return node.status(lastStatus);
        const waiting = [...runs.values()].filter((r) => r.state === 'waiting').length;
        const text = `${runs.size} running, ${queue.length} queued` + (waiting ? `, ${waiting} waiting` : '');
        node.status({ fill: waiting ? 'yellow' : 'blue', shape: 'dot', text });
    }

    function event(run, kind, text, extra) {
        // The popup chat view needs the full text of chat kinds. The events output always gets the cut text.
        const e = { runId: run.id, seq: ++run.seq, time: Date.now(), kind, text: CHAT_KINDS.has(kind) ? String(text) : cut(text) };
        log.push(e);
        if (log.length > LOG_SIZE) log.shift();
        const out = RED.util.cloneMessage(run.msg);
        out.topic = `agent/${node.id}/${run.id}`;
        out.payload = { ...e, text: cut(e.text) };
        run.send([null, null, out]);
        comms.publish('event', e);
        // The agent-watch nodes listen here. They get the same text as the popup.
        events.emit('event', { ...e, nodeId: node.id, z: node.z, stage: stageKey, ...extra });
    }

    function setState(run, state) {
        run.state = state;
        event(run, 'state', state);
        comms.publish('runs', runList());
        showStatus();
    }

    // Give a user message to the session. The run stays open until a result has used it.
    function push(run, text) {
        const uuid = crypto.randomUUID();
        run.pending.add(uuid);
        run.inbox.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, uuid });
        if (run.wake) run.wake();
    }

    // The streaming input of the session. It ends when the run ends.
    async function* input(run) {
        while (!run.ended) {
            if (run.inbox.length) yield run.inbox.shift();
            else await new Promise((resolve) => { run.wake = resolve; });
            run.wake = null;
        }
    }

    function askTool(sdk, run) {
        const description = 'Ask the human operator a question and wait for the answer. ' +
            'Put the possible answers in options, or give an empty list for a free answer.';
        return sdk.tool('ask_operator', description, { question: z.string(), options: z.array(z.string()) },
            ({ question, options }) => new Promise((resolve) => {
                run.answer = resolve;
                run.question = { question, options };
                event(run, 'question', question);
                setState(run, 'waiting');
                const out = RED.util.cloneMessage(run.msg);
                out.payload = { question, options };
                out.agent = { runId: run.id, sessionId: run.sessionId, state: 'waiting' };
                run.send([null, out, null]);
            }));
    }

    // Settle the open ask_operator call, if there is one. An error result tells the agent that no answer comes.
    function settle(run, text, isError) {
        const resolve = run.answer;
        run.answer = null;
        run.question = null;
        if (resolve) resolve({ content: [{ type: 'text', text }], isError });
    }

    // End the session of a run and free its slot. Return false if the run has already ended.
    function end(run) {
        if (run.ended) return false;
        run.ended = true;
        clearTimeout(run.timer);
        settle(run, 'The run has ended. No answer comes.', true);
        if (run.wake) run.wake();
        if (run.query) run.query.close();
        runs.delete(run.id);
        return true;
    }

    function afterEnd(status) {
        lastStatus = status;
        comms.publish('runs', runList());
        showStatus();
        startNext();
    }

    function succeed(run, payload) {
        if (!end(run)) return;
        const msg = run.msg;
        const tokens = tokenText(run.tokens);
        event(run, 'result', `done, ${run.turns} turns, ${tokens}`, { turns: run.turns, tokens, tokenCount: run.tokens || 0, weightedCount: run.weighted || 0, costUsd: run.cost || 0 });
        msg.payload = payload;
        msg.stages = { ...msg.stages, [stageKey]: payload };
        msg.agent = {
            runId: run.id, sessionId: run.sessionId, model: run.model,
            turns: run.turns, durationMs: Date.now() - run.startTime, tokens: run.tokens, weighted: run.weighted || 0, usage: run.usage
        };
        run.send([msg, null, null]);
        run.done();
        afterEnd({ fill: 'green', shape: 'dot', text: `done, ${costText(run.cost)}, ${weightedText(run.weighted)}` });
    }

    function fail(run, err) {
        if (!end(run)) return;
        event(run, 'error', err.message, { reason: err.reason || 'sdk_error', tokenCount: run.tokens || 0, weightedCount: run.weighted || 0, costUsd: run.cost || 0 });
        run.msg.agent = { runId: run.id, sessionId: run.sessionId, tokens: run.tokens, weighted: run.weighted || 0, reason: err.reason || 'sdk_error' };
        run.done(err);
        afterEnd({ fill: 'red', shape: 'ring', text: err.message.slice(0, 60) });
    }

    // The operator stopped the run. This is not an error.
    function stop(run) {
        if (!end(run)) return;
        event(run, 'state', 'stopped', { tokenCount: run.tokens || 0, weightedCount: run.weighted || 0, costUsd: run.cost || 0 });
        run.done();
        afterEnd({ fill: 'grey', shape: 'ring', text: 'stopped' });
    }

    function onResult(run, m) {
        // An error result, for example "Not logged in", has no model response.
        if (!m.is_error) touch(run);
        run.tokens = tokenCount(m.modelUsage);
        run.weighted = weightedCount(m.modelUsage);
        run.cost = m.total_cost_usd || 0;
        run.usage = m.modelUsage;
        // A result without user_message_uuids has used all pending messages.
        if (m.user_message_uuids && m.user_message_uuids.length) {
            for (const uuid of m.user_message_uuids) run.pending.delete(uuid);
        } else {
            run.pending.clear();
        }
        const interrupted = INTERRUPTED.includes(m.terminal_reason);
        if (!interrupted && (m.subtype !== 'success' || m.is_error)) {
            const text = (m.errors && m.errors.join('; ')) || m.result || m.subtype;
            return fail(run, failure(REASONS[m.subtype] || 'sdk_error', text));
        }
        if (!interrupted && !run.pending.size) return succeed(run, run.schema ? m.structured_output : m.result);
        // The run stays open for the pending messages, or for a new message after an interrupt.
        event(run, 'turn', interrupted ? 'interrupted' : m.result);
        if (!run.pending.size) setState(run, 'interrupted');
    }

    async function start({ msg, send, done, text }) {
        const run = {
            id: crypto.randomUUID().slice(0, 8), msg, send, done, seq: 0, state: 'starting', startTime: Date.now(),
            sessionId: undefined, model: undefined, turns: 0, messageId: null, lastActivity: null, tokens: undefined, usage: undefined,
            schema: null, pending: new Set(), inbox: [], wake: null, answer: null, question: null, query: null,
            timer: null, ended: false
        };
        runs.set(run.id, run);
        setState(run, 'starting');
        if (timeoutMs) run.timer = setTimeout(() => fail(run, failure('timeout', 'timeout')), timeoutMs);
        try {
            const sandbox = config.sandbox || '';
            if (sandbox && !settings.sandboxPattern.test(sandbox)) throw new Error(`the sandbox name "${sandbox}" is not valid`);
            if (sandbox && !settings.launcher) throw new Error('a sandbox run needs claudeAgent.launcher in settings.js');
            const cwd = workFolder(msg.cwd || config.cwd || settings.workRoot, settings.workRoot, sandbox);
            if (config.outputSchema) run.schema = JSON.parse(config.outputSchema);
            const extraServers = config.mcpServers ? JSON.parse(config.mcpServers) : {};
            const tools = splitList(config.tools);
            const sdk = await loadSdk();
            if (run.ended) return;
            // These variables would override the cache time of the node.
            const env = { ...process.env };
            for (const name of ['FORCE_PROMPT_CACHING_5M', 'CLAUDE_CODE_PROMPT_CACHE_TTL', 'CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL']) delete env[name];
            const options = {
                pathToClaudeCodeExecutable: settings.launcher,
                // A sandbox run: the launcher starts the CLI in the sandbox, in the folder NODE_RED_CLAUDE_CWD.
                cwd: sandbox ? settings.workRoot : cwd,
                env: { ...env, ...(sandbox && { NODE_RED_CLAUDE_SANDBOX: sandbox, NODE_RED_CLAUDE_CWD: cwd }) },
                model: (MSG_MODELS.has(msg.model) && msg.model) || config.model || undefined,
                maxTurns,
                maxBudgetUsd: maxCostUsd,
                resume: msg.agent && typeof msg.agent.resume === 'string' ? msg.agent.resume : undefined,
                // Full environment: load the user and project settings, skills and MCP servers.
                // Else load no user settings, skills or outside MCP servers.
                settingSources: config.fullEnvironment ? ['user', 'project'] : config.projectSettings ? ['project'] : [],
                skills: config.fullEnvironment ? undefined : [],
                strictMcpConfig: !config.fullEnvironment,
                // No auto memory. No Claude attribution line in commit messages and pull requests.
                // The cache time of the node, for the main agent and for the subagents.
                settings: { autoMemoryEnabled: false, attribution: { commit: '', pr: '' }, promptCacheTtl: cacheTtl, subagentPromptCacheTtl: cacheTtl },
                systemPrompt: { type: 'preset', preset: 'claude_code', append: config.systemPrompt || undefined },
                tools: tools.length ? tools : undefined,
                mcpServers: { ...extraServers, operator: sdk.createSdkMcpServer({ name: 'operator', tools: [askTool(sdk, run)] }) },
                permissionMode: 'bypassPermissions',
                allowDangerouslySkipPermissions: true,
                outputFormat: run.schema ? { type: 'json_schema', schema: run.schema } : undefined
            };
            const escape = (v) => (typeof v === 'object' ? JSON.stringify(v) : String(v));
            const prompt = text === undefined ? mustache.render(config.prompt || '{{payload}}', msg, {}, { escape }) : text;
            event(run, 'prompt', prompt);
            push(run, prompt);
            run.query = sdk.query({ prompt: input(run), options });
            setState(run, 'running');
            for await (const m of run.query) {
                if (m.session_id) {
                    // Another session becomes the last session: its cache state replaces the old one.
                    if (m.session_id !== lastSessionId && sessionActivity !== run.lastActivity) {
                        sessionActivity = run.lastActivity;
                        comms.publish('session', session());
                    }
                    run.sessionId = lastSessionId = m.session_id;
                    lastSessionCwd = cwd;
                }
                if (m.type === 'system' && m.subtype === 'init') run.model = m.model;
                else if (m.type === 'result') onResult(run, m);
                else if (m.type === 'assistant' || m.type === 'user') {
                    // Each new model message of the main agent is one turn.
                    if (m.type === 'assistant' && !m.parent_tool_use_id && m.message.id !== run.messageId) {
                        run.messageId = m.message.id;
                        run.turns++;
                        // The CLI writes a <synthetic> message for an error without a model call.
                        if (m.message.model !== '<synthetic>') touch(run);
                        comms.publish('runs', runList());
                    }
                    for (const b of Array.isArray(m.message.content) ? m.message.content : []) {
                        if (b.type === 'text' && m.type === 'assistant') event(run, 'text', b.text);
                        else if (b.type === 'tool_use') event(run, 'tool', `${b.name} ${JSON.stringify(b.input)}`);
                        else if (b.type === 'tool_result') event(run, 'tool_result', b.content);
                    }
                }
                if (run.ended) break;
            }
            fail(run, new Error('the session ended without a result'));
        } catch (err) {
            fail(run, err);
        }
    }

    function startNext() {
        while (!closing && queue.length && runs.size < maxParallel) start(queue.shift());
    }

    function control(cmd, runId, payload) {
        const run = runId ? runs.get(runId) : runs.size === 1 ? runs.values().next().value : null;
        if (!run) throw new Error(runId ? `no active run ${runId}` : `give a runId: the node has ${runs.size} active runs`);
        const text = payload == null ? '' : typeof payload === 'string' ? payload : JSON.stringify(payload);
        if (cmd === 'stop') return stop(run);
        if (!run.query) throw new Error('the run has not started yet');
        if (cmd === 'answer') {
            if (!run.answer) throw new Error('the run has no open question');
            event(run, 'answer', text);
            settle(run, text, false);
            setState(run, 'running');
        } else if (cmd === 'message') {
            push(run, text);
            event(run, 'message', text);
            if (run.state === 'interrupted') setState(run, 'running');
        } else if (cmd === 'interrupt') {
            settle(run, 'The operator interrupted the turn. No answer comes.', true);
            run.query.interrupt().catch((err) => fail(run, err));
        } else {
            throw new Error(`unknown cmd "${cmd}"`);
        }
    }

    node.on('input', (msg, send, done) => {
        const cmd = msg.agent && msg.agent.cmd;
        if (!cmd) {
            queue.push({ msg, send, done });
            startNext();
            return showStatus();
        }
        try {
            control(cmd, msg.agent.runId, msg.payload);
            done();
        } catch (err) {
            done(err);
        }
    });

    node.on('close', () => {
        closing = true;
        for (const run of [...runs.values()]) fail(run, failure('node_closed', 'node closed'));
        for (const job of queue.splice(0)) {
            job.msg.agent = { reason: 'node_closed' };
            job.done(failure('node_closed', 'node closed'));
        }
    });

    // The popup asks for the log when it opens, and sends the Send, Answer, option, Interrupt, Stop and New chat buttons.
    // The node publishes 'event', 'runs', 'session' and 'cleared' to the popup.
    comms.subscribe('get-log', () => ({ events: log, runs: runList(), session: session() }));
    // New chat: the next popup run starts a new session. The popup log is cleared.
    comms.subscribe('new-chat', () => {
        if (runs.size || queue.length) return { error: 'stop the active run first' };
        lastSessionId = undefined;
        lastSessionCwd = undefined;
        sessionActivity = null;
        log.length = 0;
        comms.publish('cleared', {});
        comms.publish('session', session());
        return {};
    });
    // The popup starts a run when the node has no active run. The run continues the last session of the node.
    comms.subscribe('start', (p) => {
        if (!p || typeof p.text !== 'string' || !p.text.trim()) return { error: 'type a message first' };
        const msg = { _msgid: RED.util.generateId(), payload: p.text };
        // A session is kept in its folder: resume it in the same folder, also when msg.cwd set that folder.
        if (lastSessionId) {
            msg.agent = { resume: lastSessionId };
            msg.cwd = lastSessionCwd;
        }
        queue.push({ msg, send: (m) => node.send(m), done: (err) => { if (err) node.error(err, msg); }, text: p.text });
        startNext();
        showStatus();
        return {};
    });
    comms.subscribe('control', (p) => {
        if (!p || typeof p.cmd !== 'string' || typeof p.runId !== 'string') return { error: 'bad request' };
        try {
            control(p.cmd, p.runId, typeof p.text === 'string' ? p.text : '');
            return {};
        } catch (err) {
            return { error: err.message };
        }
    });
}, {
    // The editor reads the Sandbox rule from this block. The runtime reads the whole block.
    settings: { claudeAgent: { value: {}, exportable: true } }
});
