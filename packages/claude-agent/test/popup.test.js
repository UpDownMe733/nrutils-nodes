'use strict';

// Runs the editor script of claude-agent.html in a small fake DOM and checks the popup.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'claude-agent.html'), 'utf8');
const script = /<script type="text\/javascript">([\s\S]*?)<\/script>/.exec(html)[1];

// A fake element: enough of the DOM for the editor script
function fakeElement(tag) {
    const classes = new Set();
    let ownText = '';
    const listeners = {};
    const e = {
        tagName: tag.toUpperCase(), style: {}, childNodes: [], value: '', clicks: 0, focused: 0, disabled: false, title: '',
        scrollTop: 0, scrollHeight: 0, attributes: {}, listeners,
        get className() { return [...classes].join(' '); },
        set className(v) { classes.clear(); String(v).split(/\s+/).filter(Boolean).forEach((c) => classes.add(c)); },
        classList: {
            add: (...c) => c.forEach((x) => classes.add(x)),
            remove: (...c) => c.forEach((x) => classes.delete(x)),
            contains: (c) => classes.has(c),
            toggle(c, force) {
                const on = force === undefined ? !classes.has(c) : !!force;
                if (on) classes.add(c); else classes.delete(c);
                return on;
            }
        },
        get textContent() { return ownText + e.childNodes.map((c) => c.textContent).join(''); },
        set textContent(v) { ownText = String(v); e.childNodes.length = 0; },
        get firstChild() { return e.childNodes[0]; },
        setAttribute(name, value) { e.attributes[name] = String(value); },
        getAttribute: (name) => e.attributes[name],
        addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
        appendChild(c) { e.childNodes.push(c); return c; },
        removeChild(c) { e.childNodes.splice(e.childNodes.indexOf(c), 1); },
        focus() { e.focused++; },
        click() { e.clicks++; (listeners.click || []).forEach((fn) => fn({ stopPropagation() {} })); }
    };
    return e;
}

// All elements below root, root first
function walk(root) {
    return [root, ...root.childNodes.flatMap(walk)];
}

// Runs the editor script. state is the answer of get-log. clock.now is the time of Date.now().
function setup(extra = {}, state = { events: [], runs: [], session: { cacheTtl: '1h', lastActivity: null } }) {
    const div = fakeElement('div');
    div.id = 'nru_popup.n1.div';
    const head = fakeElement('head');
    const document = {
        head,
        createElement: fakeElement,
        // Only the elements in the document: the popup div and the head
        getElementById: (id) => [...walk(div), ...walk(head)].find((e) => e.id === id) || null
    };
    const clock = { now: 0, timers: [] };
    class FakeDate extends Date {
        constructor(...args) { super(...(args.length ? args : [clock.now])); }
        static now() { return clock.now; }
    }
    const setInterval = (fn, ms) => { const t = { fn, ms, on: true }; clock.timers.push(t); return t; };
    const clearInterval = (t) => { if (t) t.on = false; };
    // Run the active timers, as the browser does after their interval
    clock.tick = (ms) => { clock.now += ms; clock.timers.filter((t) => t.on).forEach((t) => t.fn()); };
    let def;
    const calls = [];
    const notes = [];
    const RED = {
        nodes: { registerType: (name, d) => { def = d; } },
        notify: (text, type) => notes.push({ text, type }),
        validators: { number: () => () => true },
        settings: {}
    };
    vm.runInNewContext(script, { document, RED, window: {}, Date: FakeDate, setInterval, clearInterval, ...extra });
    const getDef = () => def;
    const answers = { 'get-log': state, 'new-chat': {} };
    const node = {
        id: 'n1',
        nodeRedEditorComms: {
            publish: (type, payload) => {
                calls.push({ type, payload });
                return Promise.resolve(type in answers ? answers[type] : {});
            }
        }
    };
    def.nru_popupInit.call(node);
    const text = document.getElementById('claude-agent-text-n1');
    // Give a message from the runtime to the popup, as the comms do
    const receive = (type, payload) => def.nodeRedEditorComms_subscriptions[type].call(node, payload);
    const part = (name) => document.getElementById('claude-agent-' + name + '-n1');
    const rebuild = () => def.nru_popupInit.call(node);
    return { text, calls, getDef, document, div, head, clock, notes, node, answers, receive, part, rebuild };
}

const key = (text, init) => {
    let prevented = 0;
    const e = { stopPropagation() {}, preventDefault() { prevented++; }, ...init };
    text.listeners.keydown.forEach((fn) => fn(e));
    return () => prevented;
};
const starts = (calls) => calls.filter((c) => c.type === 'start');

describe('claude-agent popup message box', () => {
    it('is a textarea', () => {
        assert.equal(setup().text.tagName, 'TEXTAREA');
    });

    it('a new node gets the popup size 480x420', () => {
        const value = setup().getDef().defaults.nru_popupConfig.value;
        assert.deepEqual(JSON.parse(JSON.stringify(value)), { width: 480, height: 420, autoCloseTime: 0 });
    });

    it('Enter sends the text, prevents the new line and clears the box', () => {
        const { text, calls } = setup();
        text.value = 'hello';
        const prevented = key(text, { key: 'Enter', shiftKey: false });
        assert.equal(prevented(), 1);
        assert.deepEqual(starts(calls).map((c) => JSON.parse(JSON.stringify(c.payload))), [{ text: 'hello' }]);
        assert.equal(text.value, '');
    });

    it('Shift+Enter does not send and does not prevent the new line', () => {
        const { text, calls } = setup();
        text.value = 'hello';
        const prevented = key(text, { key: 'Enter', shiftKey: true });
        assert.equal(prevented(), 0);
        assert.equal(starts(calls).length, 0);
        assert.equal(text.value, 'hello');
    });

    it('Enter during IME composition does not send', () => {
        const { text, calls } = setup();
        text.value = 'hello';
        key(text, { key: 'Enter', shiftKey: false, isComposing: true });
        assert.equal(starts(calls).length, 0);
    });

    it('a text with a new line goes out unchanged', () => {
        const { text, calls } = setup();
        text.value = 'line one\nline two';
        key(text, { key: 'Enter', shiftKey: false });
        assert.deepEqual(starts(calls).map((c) => JSON.parse(JSON.stringify(c.payload))), [{ text: 'line one\nline two' }]);
    });
});

describe('claude-agent edit dialog', () => {
    const open = (cacheTtl) => {
        const set = [];
        const $ = (sel) => ({ val: (v) => set.push([sel, v]) });
        const { getDef } = setup({ $ });
        getDef().oneditprepare.call({ cacheTtl });
        return set;
    };

    it('shows 60 minutes for a node without a Cache time', () => {
        assert.deepEqual(open(undefined), [['#node-input-cacheTtl', '1h']]);
    });

    it('shows 60 minutes for an unknown Cache time', () => {
        assert.deepEqual(open(''), [['#node-input-cacheTtl', '1h']]);
    });

    it('leaves a stored Cache time alone', () => {
        assert.deepEqual(open('5m'), []);
        assert.deepEqual(open('1h'), []);
    });
});

const MIN = 60000;
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const run = (extra) => ({ runId: 'r1', state: 'running', turns: 1, tokens: '1.1k tokens', question: null, startTime: 0, lastActivity: null, ...extra });
const event = (kind, text, extra) => ({ runId: 'r1', seq: 1, time: 0, kind, text, ...extra });
// The popup after get-log, with the clock at now
async function popup(state, now = 0) {
    const p = setup({}, { events: [], runs: [], session: { cacheTtl: '1h', lastActivity: null }, ...state });
    p.clock.now = now;
    await settle();
    return p;
}

describe('claude-agent popup timer chip', () => {
    it('counts down the 60-minute cache of the last session with two digits', async () => {
        const { part } = await popup({ session: { cacheTtl: '1h', lastActivity: 0 } }, 8 * MIN);
        assert.equal(part('chip').textContent, 'Cache 52m');
        assert.equal(part('chip').classList.contains('ca-warn'), false);
    });

    it('counts down the 5-minute cache, turns amber, and says cold at the end', async () => {
        const { part, clock, receive } = await popup({ session: { cacheTtl: '5m', lastActivity: 0 } }, 30000);
        assert.equal(part('chip').textContent, 'Cache 05m');
        assert.equal(part('chip').classList.contains('ca-warn'), true);
        clock.now = 5 * MIN;
        receive('session', { cacheTtl: '5m', lastActivity: 0 });
        assert.equal(part('chip').textContent, 'Cache cold');
        assert.match(part('chip').title, /full context again at the full price/);
    });

    it('says New chat when the node has no session', async () => {
        const { part } = await popup({});
        assert.equal(part('chip').textContent, 'New chat');
    });

    it('shows the active time and Cache -- before the first response of a run', async () => {
        const { part } = await popup({ runs: [run()] }, 2 * MIN);
        assert.equal(part('chip').textContent, 'Active 2m · Cache --');
    });

    it('shows hours and minutes after 60 minutes, and the cache from the last response of the run', async () => {
        const { part } = await popup({ runs: [run({ lastActivity: 60 * MIN })] }, 65 * MIN);
        assert.equal(part('chip').textContent, 'Active 1h 05m · Cache 55m');
    });

    it('a timer updates the chip every 10 s and stops when the popup has gone', async () => {
        const { part, clock, div } = await popup({ session: { cacheTtl: '1h', lastActivity: 0 } }, 0);
        assert.equal(part('chip').textContent, 'Cache 60m');
        const timers = clock.timers.filter((t) => t.on);
        assert.equal(timers.length, 1);
        assert.equal(timers[0].ms, 10000);
        clock.tick(MIN + 10000);
        assert.equal(part('chip').textContent, 'Cache 59m');
        div.textContent = '';
        clock.tick(10000);
        assert.equal(clock.timers.filter((t) => t.on).length, 0);
    });

    it('a rebuild of the popup keeps one timer', async () => {
        const { clock, rebuild } = await popup({});
        rebuild();
        rebuild();
        assert.equal(clock.timers.filter((t) => t.on).length, 1);
    });
});

describe('claude-agent popup buttons', () => {
    it('Interrupt and Stop are hidden without a run and shown with a run', async () => {
        const { part, receive } = await popup({});
        assert.equal(part('interrupt').style.display, 'none');
        assert.equal(part('stop').style.display, 'none');
        receive('runs', [run()]);
        assert.equal(part('interrupt').style.display, '');
        assert.equal(part('stop').style.display, '');
    });

    it('New chat publishes new-chat and puts the focus in the message box', async () => {
        const { part, calls, text } = await popup({});
        assert.equal(part('new').disabled, false);
        part('new').click();
        assert.deepEqual(calls.filter((c) => c.type === 'new-chat').length, 1);
        assert.equal(text.focused, 1);
    });

    it('New chat is disabled with an active run', async () => {
        const { part, receive } = await popup({ runs: [run()] });
        assert.equal(part('new').disabled, true);
        receive('runs', []);
        assert.equal(part('new').disabled, false);
    });

    it('New chat shows the error of the runtime', async () => {
        const { part, answers, notes } = await popup({});
        answers['new-chat'] = { error: 'stop the active run first' };
        part('new').click();
        await settle();
        assert.deepEqual(notes, [{ text: 'stop the active run first', type: 'warning' }]);
    });

    it('Send says Answer when the run waits for an answer', async () => {
        const { part } = await popup({ runs: [run({ state: 'waiting', question: { question: 'Go?', options: ['yes'] } })] });
        assert.equal(part('send').textContent.trim(), 'Answer');
        assert.equal(part('ask').style.display, '');
    });
});

describe('claude-agent popup chat', () => {
    it('shows the empty state before the first entry', async () => {
        const { part, receive } = await popup({});
        assert.equal(part('empty').style.display, undefined);
        assert.equal(part('empty').textContent, 'Ask the agent a question below.');
        receive('event', event('prompt', 'hello'));
        assert.equal(part('empty').style.display, 'none');
    });

    it('shows the working line while the selected run is starting or running', async () => {
        const { part, receive } = await popup({});
        assert.equal(part('working').style.display, 'none');
        receive('runs', [run({ state: 'starting' })]);
        assert.equal(part('working').style.display, '');
        receive('runs', [run({ state: 'waiting' })]);
        assert.equal(part('working').style.display, 'none');
        receive('runs', [run({ state: 'running' })]);
        assert.equal(part('working').style.display, '');
    });

    it('operator and agent entries get their classes, a meta line and no inline colour', async () => {
        const { part, receive } = await popup({});
        receive('event', event('prompt', 'hello', { time: new Date(2026, 0, 1, 14, 2).getTime() }));
        receive('event', event('text', 'hi there', { time: new Date(2026, 0, 1, 14, 3).getTime() }));
        receive('event', event('question', 'Go?'));
        receive('event', event('error', 'boom'));
        const [you, agent, question, end] = part('list').childNodes;
        assert.ok(you.classList.contains('ca-op'));
        assert.equal(you.childNodes[0].textContent, 'You · 14:02');
        assert.equal(you.childNodes[1].textContent, 'hello');
        assert.ok(agent.classList.contains('ca-agent'));
        assert.equal(agent.childNodes[0].textContent, 'Agent · 14:03');
        assert.ok(question.classList.contains('ca-question'));
        assert.ok(end.classList.contains('ca-end') && end.classList.contains('ca-error'));
        for (const e of [you, agent, question, end, ...you.childNodes, ...agent.childNodes]) {
            assert.deepEqual(e.style, {}, 'no inline style');
        }
    });

    it('keeps 200 entries', async () => {
        const { part, receive } = await popup({});
        for (let i = 0; i < 205; i++) receive('event', event('text', 'line ' + i));
        assert.equal(part('list').childNodes.length, 200);
        assert.equal(part('log').childNodes.length, 200);
    });

    it('a cleared message empties the chat and the Timeline', async () => {
        const { part, receive } = await popup({ events: [event('prompt', 'hello'), event('result', 'done')] });
        assert.equal(part('list').childNodes.length, 2);
        receive('cleared', {});
        assert.equal(part('list').childNodes.length, 0);
        assert.equal(part('log').childNodes.length, 0);
        assert.equal(part('empty').style.display, '');
    });

    it('after a cleared message the status line says no active run, not the end of the earlier run', async () => {
        const p = setup({}, { events: [], runs: [], session: { cacheTtl: '1h', lastActivity: null } });
        // The status line of the popup frame, as nru_popup makes it
        const status = fakeElement('div');
        status.id = 'nru_popup.n1.statusText';
        status.setStatusText = (v) => { status.textContent = v; };
        p.div.appendChild(status);
        p.receive('event', event('result', 'all done'));
        p.receive('runs', []);
        assert.equal(status.textContent, 'all done');
        p.receive('cleared', {});
        assert.equal(status.textContent, 'no active run');
    });

    it('adds the style element once, with theme variables and no fixed colour but the node colour', async () => {
        const { head, rebuild } = await popup({});
        rebuild();
        const styles = head.childNodes.filter((e) => e.id === 'claude-agent-style');
        assert.equal(styles.length, 1);
        const colours = styles[0].textContent.match(/#[0-9a-f]{3,6}\b/gi);
        assert.deepEqual([...new Set(colours)].sort(), ['#000', '#9fd8d0']);
        assert.doesNotMatch(html, /#fff3cd/);
    });
});
