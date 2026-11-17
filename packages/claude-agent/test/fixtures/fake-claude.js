'use strict';

// A small stand-in for the Claude Code CLI. The tests set it as claudeAgent.launcher in settings.js.
// It reads and writes the stream-json protocol of the CLI on stdin and stdout. It calls no service.
// The first word of the prompt selects what it does:
//   silent          starts the session other-session and gives no model response and no result
//   nologin         acts as the CLI without a login: a <synthetic> message, then an error result
//   ask <question>  asks the operator through the ask_operator tool, then gives the answer as the result
//   maxturns        ends with the error result error_max_turns
//   wait            gives no result: the run waits until somebody stops it
//   slowdone        gives the result after one second
//   twoturns        gives a second model response after half a second, and the result half a second later
//   big             gives a model response with a context of 150000 tokens, then the result
//   long            gives a model response with a context of 150000 tokens, then calls the PostToolUse hook.
//                   If the hook asks for the handoff tool, it calls handoff with the note "the handoff note" and
//                   gives no result. Else the result is "no hint".
//   send <to> <text> calls the send tool, then gives the result "send replied: " and the text of the tool
//   Write what...   the close prompt of an agent: the result is the text of close-answer.txt in the folder,
//                   else "The note of the fake."
//   Stage           a call of the agent-watch narrator: one line for each stage of the prompt.
//                   It appends one line to narrator-calls.log in its folder. If the prompt has the
//                   word narratorfail, the call fails. If it has the word slowdone, it answers after two seconds.
//   any other text  gives a JSON result: the prompt, the folder, the sandbox variables, the settings
//                   of --settings, FORCE_PROMPT_CACHING_5M, CLAUDE_CODE_PROMPT_CACHE_TTL,
//                   CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL and some arguments (also --resume)

const fs = require('fs');
const readline = require('readline');

const args = process.argv.slice(2);
// The value of an argument: --name value or --name=value
const arg = (name) => {
    const i = args.indexOf(name);
    if (i >= 0) return args[i + 1];
    const joined = args.find((a) => a.startsWith(name + '='));
    return joined ? joined.slice(name.length + 1) : null;
};
// The --settings argument is a JSON text or the path of a JSON file.
function readSettings() {
    const value = arg('--settings');
    if (!value) return null;
    return JSON.parse(value.trim().startsWith('{') ? value : fs.readFileSync(value, 'utf8'));
}
const sessionId = 'fake-session';
const model = arg('--model') || 'claude-sonnet-fake';
const waiting = new Map();      // request id of a control request to the SDK -> resolve
let hookIds = [];               // the callback ids of the PostToolUse hooks of the SDK
let count = 0;

const write = (m) => process.stdout.write(JSON.stringify(m) + '\n');

function request(body) {
    const id = 'fake-' + ++count;
    write({ type: 'control_request', request_id: id, request: body });
    return new Promise((resolve) => waiting.set(id, resolve));
}

function result(text, subtype = 'success') {
    write({
        type: 'result', subtype, is_error: subtype !== 'success', result: text, errors: subtype === 'success' ? undefined : [subtype],
        session_id: sessionId, num_turns: 1, duration_ms: 1, total_cost_usd: 0.01,
        usage: { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        modelUsage: { [model]: { inputTokens: 1000, outputTokens: 100, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } }
    });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A model response. tokens is the input context of the response.
function reply(text, tokens = 10) {
    write({ type: 'assistant', session_id: sessionId, parent_tool_use_id: null,
        message: { id: 'message-' + ++count, role: 'assistant', content: [{ type: 'text', text }],
            usage: { input_tokens: tokens, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 5 } } });
}

// Call a tool of the operator MCP server of the node. Give the text of the tool result.
async function callTool(name, args) {
    const response = await request({ subtype: 'mcp_message', server_name: 'operator', message: {
        jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } } });
    return response.mcp_response.result.content[0].text;
}

async function narrate(prompt) {
    fs.appendFileSync('narrator-calls.log', prompt.split('\n')[0] + '\n');
    if (/\bnarratorfail\b/.test(prompt)) return result('', 'error_during_execution');
    if (/\bslowdone\b/.test(prompt)) await sleep(2000);
    const stages = [...prompt.matchAll(/^Stage (\d+): /gm)].map((m) => `${m[1]}: The agent works on its task.`);
    result(stages.join('\n'));
}

// The CLI makes no model call. Its result has the subtype success and is_error true.
function noLogin() {
    const text = 'Not logged in · Please run /login';
    write({ type: 'system', subtype: 'init', session_id: sessionId, model });
    write({ type: 'assistant', session_id: sessionId, parent_tool_use_id: null,
        message: { id: 'message-' + ++count, model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text }] } });
    write({
        type: 'result', subtype: 'success', is_error: true, result: text, session_id: sessionId, num_turns: 1, duration_ms: 1,
        total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        modelUsage: {}, terminal_reason: 'api_error'
    });
}

async function answer(prompt) {
    if (/^Stage \d+: /.test(prompt)) return narrate(prompt);
    if (prompt.split(' ')[0] === 'nologin') return noLogin();
    if (prompt.split(' ')[0] === 'silent') return write({ type: 'system', subtype: 'init', session_id: 'other-session', model });
    write({ type: 'system', subtype: 'init', session_id: sessionId, model });
    const word = prompt.split(' ')[0];
    if (prompt.startsWith('Write what a new session')) {
        reply('I write the note.');
        return result(fs.existsSync('close-answer.txt') ? fs.readFileSync('close-answer.txt', 'utf8') : 'The note of the fake.');
    }
    reply('I work on: ' + prompt, ['big', 'long'].includes(word) ? 150000 : 10);
    if (word === 'wait') return;
    if (word === 'slowdone') return sleep(1000).then(() => result('done'));
    if (word === 'twoturns') {
        await sleep(500);
        reply('The second turn.', 2500);
        await sleep(500);
        return result('done');
    }
    if (word === 'maxturns') return result('', 'error_max_turns');
    if (word === 'big') return result('done');
    if (word === 'send') {
        const [, to, ...text] = prompt.split(' ');
        return result('send replied: ' + await callTool('send', { to, text: text.join(' ') }));
    }
    if (word === 'long') {
        const hook = hookIds.length ? await request({ subtype: 'hook_callback', callback_id: hookIds[0], tool_use_id: 'tool-1',
            input: { hook_event_name: 'PostToolUse', session_id: sessionId, transcript_path: '', cwd: process.cwd(),
                tool_name: 'Bash', tool_input: {}, tool_response: '', tool_use_id: 'tool-1' } }) : {};
        const hint = (hook.hookSpecificOutput && hook.hookSpecificOutput.additionalContext) || '';
        if (!/handoff tool/.test(hint)) return result('no hint');
        return callTool('handoff', { note: 'the handoff note' });
    }
    if (word === 'ask') return result('The operator said: ' + await callTool('ask_operator', { question: prompt.slice(4), options: ['yes', 'no'] }));
    result(JSON.stringify({
        prompt, cwd: process.cwd(), model: arg('--model'), effort: arg('--effort'), permissionMode: arg('--permission-mode'), resume: arg('--resume'),
        settings: readSettings(), forceCache5m: process.env.FORCE_PROMPT_CACHING_5M || null,
        cacheTtlEnv: process.env.CLAUDE_CODE_PROMPT_CACHE_TTL || null,
        subagentCacheTtlEnv: process.env.CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL || null,
        sandbox: process.env.NODE_RED_CLAUDE_SANDBOX || null, sandboxCwd: process.env.NODE_RED_CLAUDE_CWD || null
    }));
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
    const m = JSON.parse(line);
    if (m.type === 'control_request') {
        if (m.request.subtype === 'initialize') hookIds = ((m.request.hooks || {}).PostToolUse || []).flatMap((h) => h.hookCallbackIds);
        // initialize and the other requests of the SDK: say yes
        write({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: {} } });
    } else if (m.type === 'control_response') {
        const resolve = waiting.get(m.response.request_id);
        waiting.delete(m.response.request_id);
        if (resolve) resolve(m.response.response);
    } else if (m.type === 'user') {
        const content = m.message.content;
        answer(typeof content === 'string' ? content : content.map((b) => b.text || '').join(''));
    }
}).on('close', () => process.exit(0));
