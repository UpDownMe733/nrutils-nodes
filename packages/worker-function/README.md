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
- [Worker to worker](#worker-to-worker)
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

## Worker to worker

When a worker function node is wired to another, the two threads connect directly:

```js
// upstream node
worker.outputPorts.publish('input', msg);

// downstream node
worker.inputPorts.subscribe('input', (msg) => { /* ... */ });
```

These messages do not pass through Node-RED, so the Debug sidebar does not see them.
`worker.outputPorts[p][w]` sends to one output `p` or one wire `w`.

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
