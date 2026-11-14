# @nrutils/node-red-text-inject

[![npm](https://img.shields.io/npm/v/@nrutils/node-red-text-inject.svg)](https://www.npmjs.com/package/@nrutils/node-red-text-inject)
[![CI](https://github.com/UpDownMe733/nrutils-nodes/actions/workflows/ci.yml/badge.svg)](https://github.com/UpDownMe733/nrutils-nodes/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](https://github.com/UpDownMe733/nrutils-nodes/blob/main/packages/text-inject/LICENSE)

A [Node-RED](https://nodered.org) node that sends the **text that you type** in its popup, the same
as an inject node.

An inject node sends a fixed value: to send a different text, you edit the node and deploy. The
text-inject node has a text box in a popup on the canvas. Type a text, click Send, and the text goes
out as `msg.payload`. No deploy is necessary for a new text.

- Type, paste or dictate a text of any length, also with line breaks.
- **Ctrl+Enter** sends.
- The popup keeps the text, so you can change it and send again.

![The edit dialog of the text-inject node](https://raw.githubusercontent.com/UpDownMe733/nrutils-nodes/main/packages/text-inject/images/editor.png)

## Contents

- [Requirements](#requirements)
- [Install](#install)
- [Node](#node)
- [Send a text](#send-a-text)
- [Messages](#messages)
- [Errors](#errors)
- [Limits](#limits)
- [Examples](#examples)
- [License](#license)

## Requirements

| | |
|---|---|
| Node-RED | ≥ 4.0 (tested on 5) |
| Node.js | ≥ 18 (Node-RED 5 needs ≥ 22) |
| OS / CPU | Any that Node-RED runs on |

## Install

In the Node-RED editor: **Menu → Manage palette → Install**, search
`@nrutils/node-red-text-inject`.

Or on the command line, in your Node-RED user directory (usually `~/.node-red`):

```sh
npm install @nrutils/node-red-text-inject
```

Then restart Node-RED. The node is in the **common** category of the palette.

## Node

| Property | Function |
|---|---|
| Name | The label of the node. |

The text is not a property: it stays in the popup, not in the flow.

## Send a text

1. Deploy the node one time.
2. Click the node to open the popup.
3. Type or dictate the text. On Windows, Win+H starts the dictation.
4. Click **Send** or press **Ctrl+Enter**.

The status of the node and the status line of the popup show the number of characters sent.
**Clear** empties the text box.

## Messages

### Input

None.

### Output

| Property | Function |
|---|---|
| `payload` | The text in the popup, as a string. |

## Errors

The popup shows the problem in its status line:

- `No runtime node: deploy it, and check that it is not disabled`: the node is new or disabled.
- `No connection to Node-RED`: the editor has lost its connection.

## Limits

- The popup keeps the text until a reload of the editor page.
- Each user of the editor has a separate text. The text is not in the flow file.
- A user needs write permission in the editor to send.

## Examples

**Menu → Import → Examples → @nrutils/node-red-text-inject**. The flow sends the text of the popup
to the Debug sidebar.

## License

Apache-2.0
