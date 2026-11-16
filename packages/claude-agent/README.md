# @nrutils/node-red-claude-agent

[![npm](https://img.shields.io/npm/v/@nrutils/node-red-claude-agent.svg)](https://www.npmjs.com/package/@nrutils/node-red-claude-agent)
[![CI](https://github.com/UpDownMe733/nrutils-nodes/actions/workflows/ci.yml/badge.svg)](https://github.com/UpDownMe733/nrutils-nodes/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](https://github.com/UpDownMe733/nrutils-nodes/blob/main/packages/claude-agent/LICENSE)

A [Node-RED](https://nodered.org) node that runs one **Claude Code agent** for each message.

Each message starts one agent run with the
[Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk). The agent can ask you a question.

- The prompt is a mustache template over the message.
- A popup shows each run as a chat and a timeline.

![The edit dialog of the claude-agent node](https://raw.githubusercontent.com/UpDownMe733/nrutils-nodes/main/packages/claude-agent/images/editor.png)

## Install

In the editor: **Menu → Manage palette → Install**. Or in your Node-RED user directory:

```sh
npm install @nrutils/node-red-claude-agent
```

Restart Node-RED. The node is in the **agents** category. It needs Node-RED 4.0 or later and
Node.js 18 or later. npm installs the SDK and its CLI. To log in, run `claude` one time as the OS
user that runs the CLI, or set `ANTHROPIC_API_KEY` for Node-RED.

## Safety

Each agent runs with `bypassPermissions`. It never asks. It uses each tool that it has, with the
rights of the OS user that runs the CLI. It can change files and run commands, also outside its
folder.

Before real work:

1. **Use a separate OS user or a container**, with a launcher (see Settings). Not your own user or root.
2. **Set a work root.** It limits the Folder, not what the agent can reach.
3. **Give only the tools that the task needs.**
4. **Set the limits** (turns, cost, timeout, parallel runs).
5. **Keep secrets away.** The agent sees the environment of Node-RED and the files of its user.

Text from outside (HTTP, MQTT, email) can tell the agent to do harm. Check it before it goes into the prompt.

## Settings

All entries of this `settings.js` block are optional. Restart Node-RED after a change.

```js
claudeAgent: {
    launcher: '/opt/node-red/claude-launcher',
    workRoot: '/srv/agent-work',
    sandboxPattern: '^box-[a-z0-9-]+$'
},
```

| Entry | Default | Function |
|---|---|---|
| `launcher` | the CLI of the SDK | A program that the SDK starts in place of the CLI. It must start the CLI with the same arguments. |
| `workRoot` | the home folder of the Node-RED user | Each Folder must be this folder or below it. |
| `sandboxPattern` | `^[A-Za-z0-9][A-Za-z0-9._-]*$` | A Sandbox name that does not match fails the run. |

A launcher for the OS user `worker`:

```sh
#!/bin/sh
exec sudo -n -E -H -u worker claude "$@"
```

The sudo rule needs the tag `SETENV`, so that the CLI gets the environment.

**Sandbox:** the launcher gets the Sandbox name in `NODE_RED_CLAUDE_SANDBOX` and the Folder in
`NODE_RED_CLAUDE_CWD`.

## Properties

| Property | Function |
|---|---|
| Name | The label, and the key in `msg.stages`. |
| Summary | A short line that the popup shows under the name. It is not sent to Claude. **From system prompt** copies the first sentence of the system prompt into the field. Check it before you click Done: the popup shows it to each person who opens the editor. Empty: no line. |
| Folder | The work folder. Empty: the work root. `msg.cwd` replaces it. |
| Sandbox | A name for the launcher. Empty: none. |
| System prompt | Text added to the Claude Code system prompt. |
| Model | Empty (the SDK default), `haiku`, `sonnet` or `opus`. `msg.model` replaces it. |
| Cache time | `5 minutes` or `60 minutes`. Default 60 minutes. |
| Prompt | A mustache template over the message. An object becomes JSON. Default `{{payload}}`. |
| Tools | A comma list. Default `Read, Grep, Glob`. Empty: all tools. |
| Project settings | Load `CLAUDE.md` and `.claude/settings.json` of the folder. Off by default. |
| Full environment | Also load user settings, skills and MCP servers. Off by default. |
| Max turns | Default 30. |
| Max cost ($) | The limit of one run. Default 2. Empty: no limit. |
| Timeout (min) | The time limit of one run. Default 30. Empty: no limit. |
| Max parallel | Runs at the same time. Default 1. More messages wait. |
| Output schema | Optional JSON schema for the result. |
| MCP servers | Optional JSON: server name to `{ command, args, env }`. |

Cache time overrides `FORCE_PROMPT_CACHING_5M`, `CLAUDE_CODE_PROMPT_CACHE_TTL` and
`CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL`. An older node gets 60 minutes.

## Prompt and result

The result goes out on output 1, with the properties of the start message:

- `msg.payload`: the final text of the agent, or the schema object.
- `msg.stages[<name>]`: the same value. The key is the node name, else the id. Earlier stages stay.
- `msg.agent`: `{ runId, sessionId, model, turns, durationMs, tokens, weighted, usage }`.

`weighted` counts tokens in sonnet input units. For each model it is
(input + 2 × cache write + r × cache read + 5 × output) × weight. Opus has weight 2 and r 0.05, sonnet 1 and 0.05, haiku 0.05 and 0.1.

To continue a session later, put its `sessionId` into `msg.agent.resume`.

## Control messages

The agent asks with the tool `ask_operator(question, options)`. The run waits. The question goes out
on output 2 and shows in the popup.

A control message has `msg.agent = { cmd, runId }` and a text in `msg.payload`. `runId` is optional
with one active run.

| `cmd` | Function |
|---|---|
| `answer` | The answer to the open question. |
| `message` | A new message for the running session. |
| `interrupt` | Stop the current turn. The run stays open. |
| `stop` | End the run. Not an error: output 1 sends nothing. |

## Popup

Click the node to open the popup. The top shows the name of the node (or `claude-agent`), its summary
(when set) and a line with its model, folder and sandbox. The last line shows the settings of the node,
not the `msg.model` or `msg.cwd` of a run. The tabs are below it: **Chat** and **Timeline**. On the right are the run
list (with more than one run), the timer chip and **New chat**.

The timer chip shows:

- **Active**: the time since the run started, for example `Active 12m`.
- **Cache**: the minutes until the prompt cache expires, for example `Cache 52m`. It restarts at each
  model response. `Cache --`: no response yet.

With no run, the chip shows the cache of the last session, or `New chat`. At 0 it shows `Cache cold`:
the next message pays the full price. The chip is amber at 5 minutes or less.

**New chat** forgets the last session and clears the log. It is not possible during a run.

In the message box, Enter sends and Shift+Enter starts a new line. **Send** sends a message to the
run, or starts a run that continues the last session. A question shows one button for each option,
and Send becomes **Answer**. **Interrupt** and **Stop** show during a run.

## Input

| Property | Function |
|---|---|
| `payload` | The default prompt is `{{payload}}`. |
| `cwd` | Optional. The work folder of this run. |
| `model` | Optional. `haiku`, `sonnet` or `opus`. |
| `agent.resume` | Optional. A session id to continue. |
| `agent.cmd` | Makes the message a control message. |

## Output

1. **Result**: see above.
2. **Question**: `msg.payload = { question, options }`, `msg.agent = { runId, sessionId, state: 'waiting' }`.
3. **Events**: `msg.topic = 'agent/<nodeId>/<runId>'`, `msg.payload = { runId, seq, time, kind, text }`.
   `kind` is `prompt`, `state`, `text`, `tool`, `tool_result`, `question`, `answer`, `message`,
   `turn`, `result` or `error`. `text` ends after 300 characters.

## Errors

A failed run goes to a Catch node. `msg.agent.reason` tells why:

| Reason | Cause |
|---|---|
| `max_turns` | The run used Max turns. |
| `max_cost` | The run used Max cost. |
| `timeout` | The run took longer than Timeout. |
| `schema` | The result does not agree with the Output schema. |
| `node_closed` | A deploy or a stop of Node-RED ended the run. |
| `sdk_error` | Any other error, for example a folder outside the work root, a bad Sandbox name, no login. |

## Limits

- A deploy ends the runs and clears the popup log.
- The popup keeps the last 200 events.
- A Sandbox name needs a launcher that reads it.
- The work root limits only the start folder.

## Example

**Menu → Import → Examples → @nrutils/node-red-claude-agent**.

## License

Apache-2.0
