/**
 * Copyright 2026 UpDownMe733
 * Licensed under the Apache License, Version 2.0
 * http://www.apache.org/licenses/LICENSE-2.0
 */

'use strict';

// The artifacts of the runtime: the store, the publish function and the admin API.
// One runtime object for each Node-RED runtime. See docs/artifacts.md.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { agentSettings } = require('../shared');
const { createStore, NAME_RULE } = require('./store');
const { tarReader } = require('./tar');
const ticket = require('./ticket');
const viewServer = require('./view-server');

const MB = 1024 * 1024;
const TIME_LIMIT_MS = 120 * 1000;
const runtimes = new WeakMap();     // RED.httpAdmin to runtime

// Read a file or a folder with the rights of the agent. dir: the folder that holds it. base: its name.
// Gives { files: [{ path, data }], folder }. A path in the files is relative to base.
function readFiles(settings, { sandbox, dir, base }) {
    const { agentExec } = settings;
    const { maxBytes, maxFiles } = settings.artifacts;
    if ((sandbox || settings.launcher) && !agentExec) {
        return Promise.reject(new Error('this node cannot read files with the rights of the agent'));
    }
    // With no launcher the agent runs as the Node-RED user: tar has the rights of the agent already.
    const command = agentExec ? [agentExec, [sandbox || '-', dir, 'tar', '-cf', '-', '--', base], {}] : ['tar', ['-cf', '-', '--', base], { cwd: dir }];
    return new Promise((resolve, reject) => {
        const child = spawn(command[0], command[1], { ...command[2], stdio: ['ignore', 'pipe', 'pipe'] });
        const reader = tarReader({ maxBytes, maxFiles });
        let errText = '';
        let failed = null;
        const timer = setTimeout(() => stop(new Error('the read of the files takes too long')), TIME_LIMIT_MS);
        const stop = (err) => {
            if (failed) return;
            failed = err;
            clearTimeout(timer);
            child.kill('SIGKILL');
            reject(err);
        };
        child.stderr.on('data', (d) => { if (errText.length < 2000) errText += d; });
        child.stdout.on('data', (chunk) => {
            if (failed) return;
            try {
                reader.write(chunk);
            } catch (err) {
                if (err.limit === 'bytes') err.message = `the file is larger than ${Math.round(maxBytes / MB)} MB`;
                else if (err.limit === 'files') err.message = `the folder has more than ${maxFiles} files`;
                stop(err);
            }
        });
        child.on('error', (err) => stop(new Error(`cannot start ${command[0]}: ${err.message}`)));
        child.on('close', (code) => {
            clearTimeout(timer);
            if (failed) return;
            if (code) return stop(new Error(errText.trim().split('\n')[0] || `tar failed with code ${code}`));
            try {
                resolve(reader.end());
            } catch (err) {
                stop(err);
            }
        });
    });
}

function createRuntime(RED) {
    const settings = agentSettings(RED);
    let store;
    let warned = false;
    const editorOrigins = new Set();
    const getStore = () => (store ??= createStore(settings.artifacts.dir));
    const viewUrl = (req) => {
        const { viewPort, viewUrl: url } = settings.artifacts;
        if (!viewPort) return null;
        const out = (url || `${req.protocol}://${req.hostname}:${viewPort}`).replace(/\/$/, '');
        // A viewer on the origin of the editor can read the editor: turn it off
        let same = false;
        try { same = new URL(out).origin === `${req.protocol}://${req.get('host')}`; } catch { /* a bad URL fails below */ }
        if (same) {
            if (!warned) RED.log.error('claude-agent: the viewer URL has the origin of the editor. The viewer is off. Use another port or host.');
            warned = true;
            return null;
        }
        return out;
    };

    // Tell the editors about a record. The comms of a node reach only that node, so this topic is global.
    const announce = (record) => RED.comms.publish('claude-agent/artifacts', { record, totalBytes: getStore().totalBytes() });

    // The publish tool of a run. ctx: { nodeId, address, cwd, sandbox, run: { runId, sessionId } }.
    // args: { path, name, title, entry, note }. Gives { title, name, version, unchanged, event }, or throws an error with the reason.
    async function publish(ctx, args) {
        const p = ctx.sandbox ? path.posix : path;
        let root = settings.workRoot.replace(/\/$/, '');
        // The run folder is a real path, so the root must be one also
        if (!ctx.sandbox) try { root = fs.realpathSync(root); } catch { /* the check below fails */ }
        const target = p.resolve(ctx.cwd, String(args.path || ''));
        if (!args.path || (target !== root && !target.startsWith(root + '/'))) throw new Error(`the path "${args.path}" is not in ${settings.workRoot}`);
        if (args.name !== undefined && !NAME_RULE.test(args.name)) throw new Error(`the name "${args.name}" is not valid: use a-z, 0-9, ".", "_" and "-", 64 characters at most`);
        const base = p.basename(target);
        const { files, folder } = await readFiles(settings, { sandbox: ctx.sandbox, dir: p.dirname(target), base });
        // A file gives one entry with the name of the file. A folder gives entries below its name.
        const own = folder ? files.map((f) => {
            if (!f.path.startsWith(base + '/')) throw new Error(`the name "${f.path}" is not in the folder`);
            return { path: f.path.slice(base.length + 1), data: f.data };
        }) : files;
        if (!folder && files.length !== 1) throw new Error(`the name "${base}" is not a file or a folder`);
        if (!own.length) throw new Error('the folder has no file');
        const result = await getStore().publish({
            nodeId: ctx.nodeId, address: ctx.address || ctx.nodeId, name: args.name, defaultName: base, title: args.title, entry: args.entry,
            note: args.note, run: ctx.run, files: own
        });
        if (!result.unchanged) announce(result.record);
        const { record, version, unchanged } = result;
        const entry = version.files.find((f) => f.path === version.entry);
        return {
            title: version.title, name: record.name, version: version.n, unchanged,
            event: { id: record.id, name: record.name, version: version.n, title: version.title, type: entry.type, size: version.files.reduce((s, f) => s + f.size, 0) }
        };
    }

    const read = RED.auth.needsPermission('claude-agent.read');
    const base = '/claude-agent/artifacts';
    const missing = (res) => res.status(404).json({ error: 'not found' });
    const write = RED.auth.needsPermission('claude-agent.write');
    RED.httpAdmin.get(base, read, (req, res) => res.json({ items: getStore().list(req.query), totalBytes: getStore().totalBytes() }));
    RED.httpAdmin.get(`${base}/:id`, read, (req, res) => {
        const record = getStore().get(req.params.id);
        return record ? res.json(record) : missing(res);
    });
    RED.httpAdmin.post(`${base}/:id/:n/ticket`, read, (req, res) => {
        const s = getStore();
        if (!s.version(req.params.id, req.params.n)) return missing(res);
        if (typeof req.headers.origin === 'string') editorOrigins.add(req.headers.origin);
        const url = viewUrl(req);
        if (!url) return res.status(409).json({ error: 'the viewer is off' });
        const t = ticket.make(s.key, req.params.id, Number(req.params.n));
        return res.json({ url: `${url}/v/${t}/`, download: `${url}/v/${t}/download` });
    });

    // Delete and undo. Each change goes to the editors with the new record.
    const change = (action) => (req, res) => {
        const { id, n } = req.params;
        const record = getStore()[action](id, n);
        if (!record) return missing(res);
        announce(record);
        return res.json(record);
    };
    RED.httpAdmin.delete(base + '/:id', write, change('remove'));
    RED.httpAdmin.delete(`${base}/:id/:n`, write, change('remove'));
    RED.httpAdmin.post(`${base}/:id/restore`, write, change('restore'));
    RED.httpAdmin.post(`${base}/:id/:n/restore`, write, change('restore'));

    // The purge of the bin: at start and then each hour
    const purge = () => getStore().purge().forEach(announce);
    purge();
    setInterval(purge, 3600 * 1000).unref();

    // The view server
    if (settings.artifacts.viewPort) {
        const tls = typeof RED.settings.https === 'function' ? RED.settings.https() : RED.settings.https;
        Promise.resolve(tls).then((options) => viewServer.start({
            store: getStore(), port: settings.artifacts.viewPort, settings: settings.artifacts, editorOrigins, tls: options, uiPort: RED.settings.uiPort
        })).catch((err) => RED.log.error(`claude-agent: the viewer did not start on port ${settings.artifacts.viewPort}: ${err.message}`));
    }

    return { publish, getStore, settings };
}

// The runtime object of the Node-RED runtime that RED belongs to.
function attach(RED) {
    let runtime = runtimes.get(RED.httpAdmin);
    if (!runtime) runtimes.set(RED.httpAdmin, runtime = createRuntime(RED));
    return runtime;
}

module.exports = { attach, readFiles };
