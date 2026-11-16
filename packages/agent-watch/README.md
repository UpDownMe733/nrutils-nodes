# @nrutils/node-red-agent-watch

[![npm](https://img.shields.io/npm/v/@nrutils/node-red-agent-watch.svg)](https://www.npmjs.com/package/@nrutils/node-red-agent-watch)
[![CI](https://github.com/UpDownMe733/nrutils-nodes/actions/workflows/ci.yml/badge.svg)](https://github.com/UpDownMe733/nrutils-nodes/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](https://github.com/UpDownMe733/nrutils-nodes/blob/main/packages/agent-watch/LICENSE)

A [Node-RED](https://nodered.org) node that shows a short **running commentary** of the
[claude-agent](https://www.npmjs.com/package/@nrutils/node-red-claude-agent) nodes on its tab.

This node collects the events of all agent stages in one list, one short line at a time, with no
wires.

- Free lines for each run: started, waits, answered, done, failed, stopped.
- A narrator adds a line about each busy stage.
- The popup shows the total cost since the deploy.

![The edit dialog of the agent-watch node](https://raw.githubusercontent.com/UpDownMe733/nrutils-nodes/main/packages/agent-watch/images/editor.png)

## Install

In the editor: **Menu → Manage palette → Install**, search `@nrutils/node-red-agent-watch`. Or in
your Node-RED user directory:

```sh
npm install @nrutils/node-red-agent-watch
```

Restart Node-RED. The node is in the **agents** category. It needs Node-RED 4.0 or later, Node.js
18 or later and `@nrutils/node-red-claude-agent` 0.1 or later (npm installs it). The narrator uses
the `claudeAgent` settings. Read the Safety and Settings sections of the
[claude-agent README](https://github.com/UpDownMe733/nrutils-nodes/blob/main/packages/claude-agent/README.md).

## Properties

| Property | Function |
|---|---|
| Name | The label of the node. |
| Narrator | Add a narrator line. On by default. |

Use one node on each tab. It sees only the agents of its own tab.

## Lines

Each line has the time, the stage (the node name, else its id) and a text. These cost no tokens:

| Line | When |
|---|---|
| `Started.` | A run starts. |
| `WAITS: question to the operator: ...` | The agent asks a question. Yellow background. |
| `Operator answered.` | The answer has come. |
| `Done. N turns, N tokens.` | The run has ended with a result. |
| `FAILED: reason.` | The run failed. Red background. |
| `Stopped by the operator.` | Somebody stopped the run. |

## Narrator

With Narrator on, one call to the haiku model gives at most one line for each busy stage: what the
agent does and why. The call uses no tools. It runs with `bypassPermissions`, through the launcher
and the work root of the claude-agent settings. If it fails, the node writes one log warning.

The interval is 30 s. Change it in `settings.js`:

```js
agentWatch: {
    narratorSeconds: 60
},
```

## Popup

The popup lists the lines, newest at the bottom. You can copy the text. A header row names the columns: Time, Stage and Line.
The Stage column fits the longest name, up to 30 characters. Drag the edge of the Stage header to change the width. The browser keeps the width for all agent-watch popups. Double-click the edge to fit again. Hover over a cut name to see all of it.
A new request adds its lines at the end. The popup does not clear itself. Only a deploy clears the lines. Its status bar shows the total cost and the weighted tokens since the deploy, for example
`Total cost: $0.42, 118.2k weighted`. `weighted` is a price-weighted count in sonnet input tokens.

## Status

| Colour | Meaning |
|---|---|
| Blue | A stage runs. |
| Yellow | A stage waits for an answer. |
| Red | The newest line is an error. |
| Grey | No stage runs. |

## Input

Wire the end of a flow here to show its result as a green line.

| Property | Function |
|---|---|
| `topic` | The stage. Default `Result`. |
| `payload` | The text. An object shows as JSON. |

The node has no output.

## Errors

The node sends no error to a Catch node.

## Limits

- The node keeps the last 300 lines. A deploy clears them and the totals. A new request only adds lines at the end.
- A narrator line comes at most once for each interval (default 30 s, set by
  `agentWatch.narratorSeconds`).

## Example

**Menu → Import → Examples → @nrutils/node-red-agent-watch**.

## License

Apache-2.0
