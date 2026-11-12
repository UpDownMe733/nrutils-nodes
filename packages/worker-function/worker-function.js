/**
 * Copyright 2026 UpDownMe733
 * Licensed under the Apache License, Version 2.0
 * http://www.apache.org/licenses/LICENSE-2.0
 */

'use strict';

// Main thread of the worker-function node.
// The code of the user runs in worker-runner.js, in a worker thread.
// Pub/sub is the only channel between this node and the worker.

const path = require('path');
const { builtinModules } = require('module');
const { NodeRedNodeBase, nodeRedWorker } = require('@nrutils/node-red-utils');

// RED.util in the worker loads this module of the Node-RED installation
let redUtilPath = null;
try {
    redUtilPath = require.resolve('@node-red/util', { paths: [path.dirname(require.main.filename)] });
} catch (err) {
    // RED.util in the worker then throws an error that says so
}

const LINKCALL_TIMEOUT = 5000;

const typeOf = (value) => value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

// The type of the first item that thisNode.send does not accept, or undefined when all items are fine.
// thisNode.send takes a message or null, an array of these, or an array of arrays of these.
function badSendType(data) {
    const items = Array.isArray(data) ? data.flatMap((item) => Array.isArray(item) ? item : [item]) : [data];
    const bad = items.findIndex((item) => item !== null && !isObject(item));
    return bad === -1 ? undefined : typeOf(items[bad]);
}

// The ArrayBuffer of a payload that can move to the worker, or null.
// A view that covers a part of its ArrayBuffer goes as a copy: the move would empty the other views.
function movableBuffer(payload) {
    if (payload instanceof ArrayBuffer) return payload;
    const whole = ArrayBuffer.isView(payload) && payload.byteOffset === 0 && payload.byteLength === payload.buffer.byteLength;
    return whole ? payload.buffer : null;
}

// Once a second, report the load of the worker thread to onLoad, as a whole percent in steps of 5.
// A report comes when the number changes, and every 10 seconds while it is above 0
// (a new or restarted editor then shows the meter again). Returns the function that stops it.
function watchLoad(worker, onLoad) {
    let last = worker.performance.eventLoopUtilization();
    let shown = -1;     // no report yet: the first sample always reports, also 0 (idle)
    let ticks = 0;
    const timer = setInterval(() => {
        const now = worker.performance.eventLoopUtilization();
        const percent = Math.round(worker.performance.eventLoopUtilization(now, last).utilization * 20) * 5;
        last = now;
        ticks++;
        if (percent === shown && !(percent > 0 && ticks % 10 === 0)) return;
        shown = percent;
        onLoad(percent);
    }, 1000);
    return () => clearInterval(timer);
}

// The status that shows the load: busy NN % (to the nearest 10, so that the text stays the same), else idle
function loadStatus(percent) {
    const tens = Math.round(percent / 10) * 10;
    return tens > 0 ? { fill: 'blue', shape: 'dot', text: `busy ${tens} %` } : { fill: 'grey', shape: 'ring', text: 'idle' };
}

// node.linkcall(target, msg, options): send msg to a link in node and wait for the
// link out node in return mode. Needs RED.nodes.linkcallTargets (Node-RED 5).
function createLinkcall(RED, thisNode) {
    const pending = new Map();      // event id -> { resolve, reject, timer }

    // A link out node in return mode calls this with the result
    thisNode.returnLinkMessage = (eventId, msg) => {
        const call = pending.get(eventId);
        if (!call) return;
        pending.delete(eventId);
        clearTimeout(call.timer);
        if (Array.isArray(msg._linkSource) && msg._linkSource.length === 0) delete msg._linkSource;
        call.resolve(msg);
    };

    return {
        call(target, msg, options = {}) {
            if (!RED.nodes.linkcallTargets) throw new Error('node.linkcall needs Node-RED 5 or later');
            if (typeof target !== 'string' || target.trim() === '') throw new Error('node.linkcall: target must be the name or id of a link in node');
            if (typeof msg !== 'object' || msg === null) throw new Error('node.linkcall: msg must be an object');
            // A node id selects one node; a name is looked up first in this flow
            const linkIn = RED.nodes.linkcallTargets.getTargetNode(thisNode, target, !RED.nodes.getNode(target));
            const timeout = options.timeout || LINKCALL_TIMEOUT;
            const id = RED.util.generateId();
            msg._linkSource = [...(msg._linkSource || []), { id, node: thisNode.id }];
            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    pending.delete(id);
                    reject(new Error(`node.linkcall: no answer from '${target}' within ${timeout} ms`));
                }, timeout);
                pending.set(id, { resolve, reject, timer });
                try {
                    linkIn.receive(msg);
                } catch (err) {
                    clearTimeout(timer);
                    pending.delete(id);
                    reject(err);
                }
            });
        },
        // The node closes: a close handler of the code that waits for a call does not wait for the time limit
        stop() {
            for (const { reject, timer } of pending.values()) {
                clearTimeout(timer);
                reject(new Error('node.linkcall: the node closed'));
            }
            pending.clear();
        }
    };
}

const registerNode = NodeRedNodeBase.createNode('worker-function', [nodeRedWorker], (RED, thisNode, config) => {
    const libs = config.libs || [];
    if (RED.settings.functionExternalModules === false && libs.length > 0) {
        throw new Error('the functionExternalModules setting is false, so the Modules list must be empty');
    }

    const worker = thisNode.nodeRedWorker.init(path.join(__dirname, 'worker-runner.js'), {
        code: config.func || '',
        node: { id: thisNode.id, name: thisNode.name || '', path: thisNode._path, outputCount: Number(config.outputs) || 0 },
        libs,
        meter: !!config.meter,
        externalModules: RED.settings.functionExternalModules !== false,
        // Node-RED installs the modules of the Modules list here (see @node-red/registry externalModules)
        userDir: path.resolve(RED.settings.userDir || process.env.NODE_RED_HOME || '.'),
        redUtilPath
    });

    worker.subscribe('send', (data) => {
        const bad = badSendType(data);
        if (bad) thisNode.error(`the 'send' data must be a message object; got ${bad}`, {});
        else thisNode.send(data);
    });
    // The meter on the canvas node (the editor draws it): the load of the worker thread, and the number
    // of calls of the 'input' handler that have started and not ended (a handler that waits for I/O
    // leaves the thread idle). The data is an object: Node-RED comms drops a falsy value such as 0.
    // Only a value above 0 stays in the comms memory, so a deleted node leaves nothing behind.
    let load = 0;
    let inProgress = 0;
    // Off by default: the node sends no meter data unless its Setup tab has the option on.
    const publishMeter = () => config.meter && RED.comms.publish(`worker-function/meter/${thisNode.id}`, { load, inProgress }, load > 0 || inProgress > 0);
    // Off by default. With the option on, the status shows the load until the code sets its own status.
    let loadOnStatus = config.loadstatus === true;
    let shownStatus;
    worker.subscribe('inProgress', (count) => {
        inProgress = count;
        publishMeter();
    });
    // No sampling timer when neither the meter nor the load status is on
    const stopLoad = config.meter || loadOnStatus ? watchLoad(worker, (percent) => {
        load = percent;
        publishMeter();
        const status = loadStatus(percent);
        if (loadOnStatus && status.text !== shownStatus) {
            shownStatus = status.text;
            thisNode.status(status);
        }
    }) : () => {};
    worker.subscribe('status', (status) => {
        if (typeof status !== 'string' && !isObject(status)) {
            thisNode.error(`the 'status' data must be an object or a string; got ${typeOf(status)}`, {});
            return;
        }
        loadOnStatus = false;
        thisNode.status(status);
    });
    for (const level of ['log', 'warn', 'debug', 'trace']) worker.subscribe(level, (text) => thisNode[level](text));
    // data is a string, or { message, msg }. A msg object lets a Catch node get the error.
    worker.subscribe('error', (data) => {
        if (typeof data === 'string') thisNode.error(data, {});
        else if (isObject(data) && typeof data.message === 'string') thisNode.error(data.message, isObject(data.msg) ? data.msg : {});
        else thisNode.error(`the 'error' data must be a text or { message, msg }; got ${typeOf(data)}`, {});
    });

    // The worker calls the main thread with '_call' and gets the result in '_callReply'
    const linkcall = createLinkcall(RED, thisNode);
    const calls = {
        context: (scope, op, ...args) => new Promise((resolve, reject) => {
            const nodeContext = thisNode.context();
            const store = scope === 'node' ? nodeContext : nodeContext[scope];
            // get() with an array of keys gives one value for each key, even for one key
            const many = op === 'get' && Array.isArray(args[0]);
            store[op](...args, (err, ...values) => err ? reject(err) : resolve(many ? values : values[0]));
        }),
        env: (name) => RED.util.getSetting(thisNode, name),
        linkcall: linkcall.call
    };
    const reply = (data) => {
        try {
            worker.publish('_callReply', data);
        } catch (cloneErr) {
            worker.publish('_callReply', { id: data.id, error: cloneErr.message });
        }
    };
    worker.subscribe('_call', ({ id, name, args }) => {
        Promise.resolve().then(() => calls[name](...args)).then(
            (value) => reply({ id, value }),
            (err) => reply({ id, error: (err && err.message) || String(err) }));
    });

    // The worker thread stops after a syntax error or a crash. Only a full deploy starts it again.
    let stopped = false;
    // The library shows the red status when the worker fails or ends. The load must not replace it.
    worker.once('exit', () => {
        stopped = true;
        stopLoad();
        load = 0;
        inProgress = 0;
        publishMeter();
    });
    worker.once('error', () => {
        loadOnStatus = false;
    });

    // Moves the ArrayBuffer of msg.payload when the option is on. A buffer that cannot move
    // (a small Buffer from the shared pool) goes as a copy.
    const publishInput = (msg) => {
        const buffer = config.transfer && movableBuffer(msg.payload);
        if (!buffer) return worker.publish('input', msg);
        try {
            worker.publish('input', msg, [buffer]);
        } catch (err) {
            worker.publish('input', msg);
        }
    };

    thisNode.on('input', (msg, send, done) => {
        if (stopped) return done(new Error('the worker is stopped. A full deploy starts it again.'));
        try {
            publishInput(msg);
            done();
        } catch (err) {
            // For example a DataCloneError: msg.req of an HTTP In node cannot go to a thread
            done(err);
        }
    });

    // After the worker has stopped, so that a status from its close handler does not stay
    thisNode.on('close', (done) => {
        stopLoad();
        load = 0;
        inProgress = 0;
        publishMeter();
        linkcall.stop();
        const finish = () => {
            thisNode.status({});
            done();
        };
        worker.terminate().then(finish, finish);
    });
}, {
    dynamicModuleList: 'libs',
    // The editor lists these in the Modules rows
    settings: { workerFunctionBuiltinModules: { value: builtinModules.filter((name) => !name.startsWith('_')), exportable: true } }
});

module.exports = function (RED) {
    registerNode(RED);
    // The code of this node is not compatible with the code of the Function node,
    // so it has its own library type
    RED.library.register('worker-functions');
};
