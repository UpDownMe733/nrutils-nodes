/**
 * Copyright 2026 UpDownMe733
 * Licensed under the Apache License, Version 2.0
 * http://www.apache.org/licenses/LICENSE-2.0
 */

'use strict';

// The fixed worker file of the worker-function node. It runs the code of the user one time.
// Keep this function synchronous up to the call of the user code: the library drops
// the early messages if the user code subscribes after an await.

const path = require('path');
const util = require('util');
const vm = require('vm');
const { createRequire, isBuiltin } = require('module');

// The helpers of RED.util that work without the Node-RED runtime
const PURE_UTIL = ['cloneMessage', 'compareObjects', 'encodeObject', 'ensureBuffer', 'ensureString', 'generateId',
    'getMessageProperty', 'setMessageProperty', 'getObjectProperty', 'setObjectProperty',
    'normalisePropertyExpression', 'normaliseNodeTypeName', 'parseContextStore'];

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

module.exports = function (worker, data) {
    const parent = worker.parentPorts;

    // The file name of the user code in stack traces. Line 1 is the first line of the editor.
    const filename = `worker-function:${data.node.id}`;
    const file = escapeRegExp(filename);
    const frameAt = new RegExp(`${file}:(\\d+):(\\d+)`);            // a stack frame: <file>:L:C
    const syntaxAt = new RegExp(`^${file}:(\\d+)\\n.*\\n([ \\t]*)\\^`);   // a SyntaxError: <file>:L, the line, the caret (indented with spaces or tabs)
    const position = (err) => {
        const stack = String(err && err.stack);
        const syntax = stack.match(syntaxAt);
        if (syntax) return ` (line ${syntax[1]}, col ${syntax[2].length + 1})`;
        const frame = stack.match(frameAt);
        return frame ? ` (line ${frame[1]}, col ${frame[2]})` : '';
    };
    const describe = (err) => ((err && err.message) || String(err)) + position(err);
    const report = (err) => parent.publish('error', describe(err));

    // A call to the main thread. Each call waits for its '_callReply'.
    const waiting = new Map();
    let nextId = 0;
    parent.subscribe('_callReply', ({ id, value, error }) => {
        const call = waiting.get(id);
        if (!call) return;
        waiting.delete(id);
        if (error === undefined) call.resolve(value);
        else call.reject(new Error(error));
    });
    const callMain = (name, ...args) => new Promise((resolve, reject) => {
        const id = nextId++;
        parent.publish('_call', { id, name, args });     // throws a DataCloneError before the call waits
        waiting.set(id, { resolve, reject });
    });

    const contextStore = (scope) => ({
        get: (...args) => callMain('context', scope, 'get', ...args),
        set: (...args) => callMain('context', scope, 'set', ...args),
        keys: (...args) => callMain('context', scope, 'keys', ...args)
    });
    const flow = contextStore('flow');
    const global = contextStore('global');

    // @node-red/util takes about 50 ms to load, so load it on the first use only
    let redUtil;
    const RED = {
        get util() {
            if (!redUtil) {
                if (!data.redUtilPath) throw new Error('RED.util: Node-RED has no @node-red/util module that this node can find');
                const all = require(data.redUtilPath).util;
                redUtil = Object.fromEntries(PURE_UTIL.map((name) => [name, all[name]]));
            }
            return redUtil;
        }
    };

    // Rooted at the Node-RED user dir: the modules that Node-RED installs, and the Node built-ins.
    // With functionExternalModules false, only the Node built-ins load.
    const userRequire = createRequire(path.join(data.userDir, 'package.json'));
    const requireModule = data.externalModules ? userRequire : (name) => {
        if (!isBuiltin(name)) throw new Error(`require('${name}'): the functionExternalModules setting is false, so only Node.js built-in modules load`);
        return userRequire(name);
    };

    const scope = {
        worker,
        node: { ...data.node, linkcall: (target, msg, options) => callMain('linkcall', target, msg, options) },
        flow,
        global,
        context: { ...contextStore('node'), flow, global },
        env: { get: (name) => callMain('env', name) },
        require: requireModule,
        util,
        RED
    };
    for (const lib of data.libs) scope[lib.var] = userRequire(lib.module);

    // A syntax error throws here, synchronously, with its position.
    // The library then shows "worker error" on the node.
    let run;
    try {
        run = vm.runInThisContext(`(async function (${Object.keys(scope).join(', ')}) {\n${data.code}\n})`,
            { filename, lineOffset: -1 });
    } catch (err) {
        err.message += position(err);
        throw err;
    }

    // With the meter option on: count the calls of the 'input' handler that have started and not ended, for the meter on the canvas node.
    // The main thread cannot see these: a handler that waits for I/O leaves the thread idle.
    if (data.meter) {
        let inProgress = 0;
        let reported = 0;
        const subscribe = parent.subscribe.bind(parent);
        parent.subscribe = (type, handler) => type !== 'input' ? subscribe(type, handler) : subscribe(type, (...args) => {
            inProgress++;
            let result;
            try {
                result = handler(...args);
            } catch (err) {
                inProgress--;
                throw err;
            }
            return Promise.resolve(result).finally(() => { inProgress--; });
        });
        setInterval(() => {
            if (inProgress !== reported) parent.publish('inProgress', reported = inProgress);
        }, 1000).unref();
    }

    // After the compile: an error of the user code goes to node.error and the worker keeps running
    // A throw in a handler of a message: a Catch node gets the message too
    worker.handlerError = (err, type, message) => {
        const text = describe(err);
        try {
            parent.publish('error', message !== null && typeof message === 'object' && !Array.isArray(message) ? { message: text, msg: message } : text);
        } catch (cloneErr) {
            // The handler changed the message so that it cannot be copied
            parent.publish('error', text);
        }
    };
    process.on('uncaughtException', report);
    process.on('unhandledRejection', report);
    run(...Object.values(scope)).catch(report);
};
