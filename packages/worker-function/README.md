# @nrutils/node-red-worker-function

[![npm](https://img.shields.io/npm/v/@nrutils/node-red-worker-function.svg)](https://www.npmjs.com/package/@nrutils/node-red-worker-function)
[![CI](https://github.com/UpDownMe733/nrutils-nodes/actions/workflows/ci.yml/badge.svg)](https://github.com/UpDownMe733/nrutils-nodes/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](https://github.com/UpDownMe733/nrutils-nodes/blob/main/packages/worker-function/LICENSE)

A Function node for [Node-RED](https://nodered.org) that runs its code in a **worker thread**.

A core Function node runs in the Node-RED thread. Heavy code in it (parsing, compression, image or
signal processing, big loops) blocks Node-RED: the editor freezes, dashboards stall and other flows
wait. The worker function node runs the code in its own thread, so Node-RED keeps running.

- The code is JavaScript, as in the Function node, with `node`, `context`, `flow`, `global`, `env`,
  `RED.util` and the Modules list.
- Worker function nodes that are wired together send messages thread to thread, not through Node-RED.
- Big buffers can move to the thread with no copy.

![The same 5 seconds of heavy code: in a core Function node the heartbeat stops, in a worker function node it keeps going](https://raw.githubusercontent.com/UpDownMe733/nrutils-nodes/main/packages/worker-function/images/demo.gif)

## Contents

- [Requirements](#requirements)
- [Install](#install)
- [Node](#node)
- [Code](#code)
- [Ports and wires](#ports-and-wires)
- [Big buffers](#big-buffers)
- [Errors](#errors)
- [Limits](#limits)
- [Examples](#examples)
- [License](#license)

## Requirements

| | |
|---|---|
| Node-RED | ≥ 4.0 (tested on 5). `node.linkcall()` needs Node-RED 5. |
| Node.js | ≥ 18 (Node-RED 5 needs ≥ 22) |
| OS / CPU | Any that Node-RED runs on |

## Install

In the Node-RED editor: **Menu → Manage palette → Install**, search
`@nrutils/node-red-worker-function`.

Or on the command line, in your Node-RED user directory (usually `~/.node-red`):

```sh
npm install @nrutils/node-red-worker-function
```

Then restart Node-RED. The node is in the **function** category of the palette.

## Node

| Property | Function |
|---|---|
| Name | The label of the node. |
| Code tab | The code that runs in the worker thread. A bar under the editor shows the errors in the code and the paths it uses. |
| Outputs | The number of outputs. |
| Move the msg.payload buffer to the worker (no copy) | Moves a large payload to the thread instead of a copy. See [Big buffers](#big-buffers). Off by default. |
| Show the load in the node status | Shows `busy NN %` or `idle` as the node status, until the code sets its own status. Off by default. |
| Show a load meter on the node | Draws a load bar on the node, with a badge for the calls in progress. Off by default. |
| Modules | Modules to load into the code, as in the Function node. |

The node has full help in the editor sidebar.

## Code

The code runs once, when the node starts. It subscribes to the messages of the flow and publishes
the results:

```js
worker.parentPorts.subscribe('input', async (msg) => {
    const factor = await flow.get('factor') || 2;
    msg.payload = msg.payload * factor;
    worker.parentPorts.publish('send', msg);
});
```

| Function node | worker function |
|---|---|
| `return msg;` | `worker.parentPorts.publish('send', msg);` |
| `node.send([a, b])` | `worker.parentPorts.publish('send', [a, b]);` |
| `node.status(s)` | `worker.parentPorts.publish('status', s);` |
| `node.warn(x)` | `worker.parentPorts.publish('warn', x);` (also `log`, `debug`, `trace`) |
| `node.error(x, msg)` | `worker.parentPorts.publish('error', { message: x, msg });` |
| `node.on('close', fn)` | `worker.parentPorts.subscribe('close', fn);` (2 s limit) |
| `flow.get('x')` | `await flow.get('x')` (all context calls return a Promise) |
| `RED.util.cloneMessage(msg)` | the same; the helpers that need the runtime are not available |

A variable outside the handlers keeps its value from message to message, until the node restarts.

## Ports and wires

The code talks to the outside through three port groups. Each has `subscribe(type, handler)` and
`publish(type, data)`.

| Group | Connects to |
|---|---|
| `worker.parentPorts` | this node in Node-RED: the messages of the flow, status, logs |
| `worker.inputPorts` | upstream worker function nodes, thread to thread |
| `worker.outputPorts` | downstream worker function nodes, thread to thread |

### Through Node-RED

Every message on the input wire arrives as `input`. `send` goes out through Node-RED to every node
on the wires, as `node.send()` does:

```js
worker.parentPorts.subscribe('input', (msg) => { /* each message of the flow */ });

worker.parentPorts.publish('send', msg);              // output 1
worker.parentPorts.publish('send', [null, msg]);      // output 2 only
worker.parentPorts.publish('send', [[m1, m2], msg]);  // two messages on output 1, one on output 2
```

### Send to other worker nodes

When a worker function node is wired to another, their threads connect directly. These messages do
not pass through Node-RED, so the Debug sidebar does not see them. A wire to a node that is not a
worker function gets only what `send` sends.

```js
worker.outputPorts.publish('input', msg);         // all outputs, all wires
worker.outputPorts[1].publish('input', msg);      // output 2, all its wires
worker.outputPorts[1][0].publish('input', msg);   // output 2, first wire only
```

Outputs and wires count from 0. Wires on an output are numbered in the order they appear in the
flow, and the numbers stay the same across deploys. A publish to an output with no worker on it is
dropped, as in Node-RED when an output has no wire.

### Receive from other worker nodes

A node has one input, so the handler gets the messages of all upstream workers. To act on one
sender, check `senderTrace`. It holds the `nodeId`, `portIndex` (output) and `connectionIndex`
(wire) of the sender. `receiverTrace` holds the same for this node.

```js
// from all upstream workers
worker.inputPorts.subscribe('input', (msg, senderTrace) => { /* ... */ });

// from one upstream node only
worker.inputPorts.subscribe('input', (msg, senderTrace) => {
    if (senderTrace.nodeId !== 'a1b2c3d4e5f60708') return;
    /* ... */
});

// from output 2 of the upstream nodes only
worker.inputPorts.subscribe('input', (msg, senderTrace) => {
    if (senderTrace.portIndex !== 1) return;
    /* ... */
});
```

Do not use the input wire numbers (`inputPorts[0][w]`) to pick a sender: they are given out as the
connections are made and change after a deploy.

### Message types

The type is any name. The sender and the receiver must use the same name. Use one name for each
kind of data:

```js
// upstream
worker.outputPorts.publish('frame', image);
worker.outputPorts.publish('settings', { threshold: 40 });

// downstream
worker.inputPorts.subscribe('frame', (image) => { /* ... */ });
worker.inputPorts.subscribe('settings', (settings) => { /* ... */ });
```

A handler for the type `default` gets every type.

## Big buffers

Messages are copied into the thread. A `Buffer` arrives as a `Uint8Array`, also on the way out:

```js
msg.payload = Buffer.from(msg.payload.buffer, msg.payload.byteOffset, msg.payload.length);
```

To move a large payload into the thread with no copy, turn on **Move the msg.payload buffer to the
worker**. To move a result out with no copy, add a transfer list:

```js
worker.parentPorts.publish('send', msg, [msg.payload.buffer]);
```

After a move, the sender cannot use the buffer.

## Errors

- A throw in a handler is a node error with the line and column. A Catch node gets it with the
  message. The worker keeps running.
- A syntax error stops the worker. The node shows `worker error` until a full deploy.

## Limits

- A `return` in a handler sends nothing. Use `publish('send', msg)`.
- A message from an HTTP In node cannot go to a thread: `msg.req` and `msg.res` cannot be copied.
- A function in a message cannot be copied. A class instance arrives as a plain object.
- Each node has one thread, and messages queue for it. To use more cores, spread the messages over
  several nodes.
- For short code, the core Function node is faster: the copy to the thread and back costs more than
  a short job saves.

## Examples

**Menu → Import → Examples → @nrutils/node-red-worker-function**. The flow counts primes in a thread
while a heartbeat keeps running, sends a message from one worker thread to another, shows the load
status, and sends an error to a Catch node.

## License

Apache-2.0
