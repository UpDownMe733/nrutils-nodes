/**
 * Copyright 2026 UpDownMe733
 * Licensed under the Apache License, Version 2.0
 * http://www.apache.org/licenses/LICENSE-2.0
 */

'use strict';

// The parts that the claude-agent node and the agent-watch node both use.
// The package @nrutils/node-red-agent-watch loads this file from this package (a peer dependency),
// so both nodes use one copy of it and one event emitter.

const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

// The claude-agent nodes emit their events here. The agent-watch nodes listen.
// Event: { nodeId, z, stage, runId, seq, time, kind, text }
// A result event also has turns, tokens (text), tokenCount, weightedCount and costUsd.
// An error event also has reason.
const events = new EventEmitter();
events.setMaxListeners(0);

// The default rule for a name in the Sandbox field: a plain name, safe as a host or container name
const DEFAULT_SANDBOX_PATTERN = '^[A-Za-z0-9][A-Za-z0-9._-]*$';

// The artifacts block of the claudeAgent settings, with the defaults (docs/artifacts.md, section 9).
// With no block, the view server is off: viewPort is 0.
function artifactSettings(RED, a) {
    return {
        dir: (a && a.dir) || path.join(RED.settings.userDir || os.homedir(), 'claude-agent', 'artifacts'),
        viewPort: a ? a.viewPort ?? 1881 : 0,
        viewUrl: (a && a.viewUrl) || '',
        sharePort: (a && a.sharePort) || 0,
        shareBind: (a && a.shareBind) || '127.0.0.1',
        publicUrl: (a && a.publicUrl) || '',
        htmlNetwork: !a || a.htmlNetwork !== false,
        shareHosts: (a && a.shareHosts) || [],
        maxBytes: (a && a.maxBytes) || 100 * 1024 * 1024,
        maxFiles: (a && a.maxFiles) || 2000
    };
}

// The claudeAgent block of the Node-RED settings.js, with the defaults
function agentSettings(RED) {
    const s = RED.settings.claudeAgent || {};
    return {
        // The program that the SDK starts in place of the Claude Code CLI. Empty: the CLI of the SDK.
        launcher: s.launcher || undefined,
        // The Folder of each run must be this folder or a folder below it.
        workRoot: s.workRoot || os.homedir(),
        // The rule for a name in the Sandbox field
        sandboxPattern: new RegExp(s.sandboxPattern || DEFAULT_SANDBOX_PATTERN),
        // The program that runs a command as the agent user: agentExec <sandbox or -> <folder> <command...>. Empty: none.
        agentExec: s.agentExec || undefined,
        artifacts: artifactSettings(RED, s.artifacts)
    };
}

// The SDK is an ES module: load it one time, on first use
let sdk;
const loadSdk = () => (sdk ??= import('@anthropic-ai/claude-agent-sdk'));

// The weighted tokens of a run, in "sonnet input tokens", for all models of the SDK modelUsage.
// Per model: (input*1 + cacheCreation*2 + cacheRead*r + output*5) * weight.
// The model is found by the word opus (weight 2, r 0.05), sonnet (1, 0.05) or haiku (0.05, 0.1) in its name.
// Any other model, fable included, gets weight 1 and r 0.05.
function weightedCount(modelUsage) {
    let n = 0;
    for (const [name, u] of Object.entries(modelUsage || {})) {
        const model = String(name).toLowerCase();
        let weight = 1;
        let r = 0.05;
        if (model.includes('opus')) weight = 2;
        else if (model.includes('haiku')) { weight = 0.05; r = 0.1; }
        n += ((u.inputTokens || 0) + (u.cacheCreationInputTokens || 0) * 2 + (u.cacheReadInputTokens || 0) * r + (u.outputTokens || 0) * 5) * weight;
    }
    return n;
}
const numberText = (n) => (n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(Math.round(n || 0)));
const weightedText = (n) => `${numberText(n)} weighted`;

module.exports = { events, agentSettings, loadSdk, weightedCount, weightedText };
