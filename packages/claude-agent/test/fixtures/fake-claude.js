'use strict';

// A small stand-in for the Claude Code CLI. The tests set it as claudeAgent.launcher in settings.js.
// It reads and writes the stream-json protocol of the CLI on stdin and stdout. It calls no service.
// The first word of the prompt selects what it does:
//   ask <question>  asks the operator through the ask_operator tool, then gives the answer as the result
//   maxturns        ends with the error result error_max_turns
//   wait            gives no result: the run waits until somebody stops it
//   any other text  gives a JSON result: the prompt, the folder, the sandbox variables and some arguments

const readline = require('readline');

const args = process.argv.slice(2);
// The value of an argument: --name value or --name=value
const arg = (name) => {
    const i = args.indexOf(name);
    if (i >= 0) return args[i + 1];
    const joined = args.find((a) => a.startsWith(name + '='));
    return joined ? joined.slice(name.length + 1) : null;
};
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

async function answer(prompt) {
    write({ type: 'system', subtype: 'init', session_id: sessionId, model });
    write({ type: 'assistant', session_id: sessionId, parent_tool_use_id: null,
        message: { id: 'message-' + ++count, role: 'assistant', content: [{ type: 'text', text: 'I work on: ' + prompt }] } });
    const word = prompt.split(' ')[0];
    if (word === 'wait') return;
    if (word === 'maxturns') return result('', 'error_max_turns');
    if (word === 'ask') {
        const reply = await request({ subtype: 'mcp_message', server_name: 'operator', message: {
            jsonrpc: '2.0', id: 1, method: 'tools/call',
            params: { name: 'ask_operator', arguments: { question: prompt.slice(4), options: ['yes', 'no'] } }
        } });
        return result('The operator said: ' + reply.mcp_response.result.content[0].text);
    }
    result(JSON.stringify({
        prompt, cwd: process.cwd(), model: arg('--model'), permissionMode: arg('--permission-mode'),
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
