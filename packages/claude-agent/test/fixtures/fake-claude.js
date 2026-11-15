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
    write({ type: 'assistant', session_id: sessionId, parent_tool_use_id: null,
        message: { id: 'message-' + ++count, role: 'assistant', content: [{ type: 'text', text: 'I work on: ' + prompt }] } });
    const word = prompt.split(' ')[0];
    if (word === 'wait') return;
    if (word === 'slowdone') return sleep(1000).then(() => result('done'));
    if (word === 'maxturns') return result('', 'error_max_turns');
    if (word === 'ask') {
        const reply = await request({ subtype: 'mcp_message', server_name: 'operator', message: {
            jsonrpc: '2.0', id: 1, method: 'tools/call',
            params: { name: 'ask_operator', arguments: { question: prompt.slice(4), options: ['yes', 'no'] } }
        } });
        return result('The operator said: ' + reply.mcp_response.result.content[0].text);
    }
    result(JSON.stringify({
        prompt, cwd: process.cwd(), model: arg('--model'), permissionMode: arg('--permission-mode'), resume: arg('--resume'),
        settings: readSettings(), forceCache5m: process.env.FORCE_PROMPT_CACHING_5M || null,
        cacheTtlEnv: process.env.CLAUDE_CODE_PROMPT_CACHE_TTL || null,
        subagentCacheTtlEnv: process.env.CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL || null,
        sandbox: process.env.NODE_RED_CLAUDE_SANDBOX || null, sandboxCwd: process.env.NODE_RED_CLAUDE_CWD || null
    }));
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
    const m = JSON.parse(line);
    if (m.type === 'control_request') {
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
