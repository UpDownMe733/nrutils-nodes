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
    let html;
    const listeners = {};
    const e = {
        tagName: tag.toUpperCase(), style: {}, childNodes: [], value: '', clicks: 0, focused: 0, disabled: false, title: '',
        scrollTop: 0, scrollHeight: 0, clientHeight: 0, attributes: {}, listeners,
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
        // A fake parser: each a and img tag of the HTML becomes an element that querySelectorAll finds
        get innerHTML() { return html; },
        set innerHTML(v) {
            html = String(v);
            for (const tagName of ['a']) e.found[tagName] = [...html.matchAll(new RegExp('<' + tagName + '[ >]', 'g'))].map(() => fakeElement(tagName));
        },
        found: {},
        querySelectorAll: (sel) => e.found[sel] || [],
        remove() { e.removed = true; },
        get firstChild() { return e.childNodes[0]; },
        setAttribute(name, value) { e.attributes[name] = String(value); },
        getAttribute: (name) => e.attributes[name],
        removeAttribute(name) { delete e.attributes[name]; },
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
function setup(extra = {}, state = { events: [], runs: [], session: { cacheTtl: '1h', lastActivity: null } }, fields = {}) {
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
    const handlers = {};
    const RED = {
        events: { on: (type, fn) => (handlers[type] = handlers[type] || []).push(fn) },
        nodes: { registerType: (name, d) => { def = d; } },
        notify: (text, type) => notes.push({ text, type }),
        // The rule of RED.validators.number: an empty or absent value is valid only with blankAllowed.
        validators: { number: (blankAllowed) => (v) => (v === '' || v === undefined ? !!blankAllowed : !isNaN(v)) },
        settings: {},
        utils: { renderMarkdown: (text) => '<md>' + text + '</md>' }
    };
    const sanitized = [];
    // A fake ResizeObserver: a test sets the size of the target, then calls resize() as the browser does at a layout
    const observed = [];
    class ResizeObserver {
        constructor(fn) { this.fn = fn; }
        observe(target) { observed.push({ fn: this.fn, target }); }
        disconnect() { for (let i = observed.length - 1; i >= 0; i--) if (observed[i].fn === this.fn) observed.splice(i, 1); }
    }
    const resize = () => observed.forEach((o) => o.fn([{ target: o.target }]));
    const DOMPurify = { sanitize: (html, config) => { sanitized.push(config); return html.replace(/<script.*?<\/script>/g, ''); } };
    const window = {};
    vm.runInNewContext(script, { document, RED, DOMPurify, window, Date: FakeDate, setInterval, clearInterval, ResizeObserver, ...extra });
    const getDef = () => def;
    const answers = { 'get-log': state, 'new-chat': {} };
    const node = {
        id: 'n1',
        ...fields,
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
    const emit = (type, ...args) => (handlers[type] || []).forEach((fn) => fn(...args));
    return { window, resize, sanitized, emit, text, calls, getDef, document, div, head, clock, notes, node, answers, receive, part, rebuild };
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
    // Open the dialog for a node with these properties. Give the calls of val(v) and toggle(on) for the selector.
    const open = (props, selector) => {
        const set = [];
        const values = { '#node-input-session': props.session };
        const handlers = {};
        const $ = (sel) => {
            const e = {
                val: (v) => (v === undefined ? values[sel] : (values[sel] = v, set.push([sel, v]), e)),
                on: (type, fn) => { handlers[sel + type] = fn; return e; },
                trigger: (type) => { handlers[sel + type](); return e; },
                toggle: (on) => { set.push([sel, on]); return e; }
            };
            return e;
        };
        const { getDef } = setup({ $ });
        getDef().oneditprepare.call(props);
        return { get set() { return set.filter(([sel]) => sel === selector); }, change: (v) => { values['#node-input-session'] = v; handlers['#node-input-sessionchange'](); } };
    };
    const cacheSet = (cacheTtl) => open({ cacheTtl }, '#node-input-cacheTtl').set;

    it('shows 60 minutes for a node without a Cache time', () => {
        assert.deepEqual(cacheSet(undefined), [['#node-input-cacheTtl', '1h']]);
    });

    it('shows 60 minutes for an unknown Cache time', () => {
        assert.deepEqual(cacheSet(''), [['#node-input-cacheTtl', '1h']]);
    });

    it('leaves a stored Cache time alone', () => {
        assert.deepEqual(cacheSet('5m'), []);
        assert.deepEqual(cacheSet('1h'), []);
    });

    it('shows the message mode for a node without a Session, and hides the agent settings', () => {
        assert.deepEqual(open({}, '#node-input-session').set, [['#node-input-session', 'message']]);
        assert.deepEqual(open({}, '.claude-agent-agent-row').set, [['.claude-agent-agent-row', false]]);
    });

    it('shows the agent settings only in the agent mode', () => {
        const dialog = open({ session: 'agent' }, '.claude-agent-agent-row');
        assert.deepEqual(dialog.set, [['.claude-agent-agent-row', true]]);
        dialog.change('message');
        assert.deepEqual(dialog.set, [['.claude-agent-agent-row', true], ['.claude-agent-agent-row', false]]);
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

describe('claude-agent popup pasted pictures', () => {
    // A fake FileReader that finishes only when the test says so
    const readers = [];
    class FileReader {
        readAsDataURL() { readers.push(this); }
        finish() { this.result = 'data:image/png;base64,AAAA'; this.onload(); }
    }
    const paste = (text) => text.listeners.paste.forEach((fn) => fn({
        clipboardData: { items: [{ kind: 'file', type: 'image/png', getAsFile: () => ({ type: 'image/png', size: 10 }) }] },
        preventDefault() {}, stopPropagation() {}
    }));
    const open = async (state) => {
        readers.length = 0;
        const p = setup({ FileReader }, { events: [], runs: [], session: { cacheTtl: '1h', lastActivity: null }, ...state });
        await settle();
        return p;
    };

    it('Send keeps a picture that is still loading, and sends it when it has loaded', async () => {
        const { part, text, calls, notes } = await open({});
        text.value = 'look';
        paste(text);
        part('send').click();
        assert.deepEqual(notes, [{ text: 'A picture is still loading.', type: 'warning' }]);
        assert.equal(calls.filter((c) => c.type === 'start').length, 0);
        readers[0].finish();
        part('send').click();
        assert.deepEqual(calls.find((c) => c.type === 'start').payload.images, [{ mediaType: 'image/png', data: 'AAAA', size: 10 }]);
    });

    it('Send as Answer keeps the pictures and says so', async () => {
        const { part, text, calls, notes } = await open({ runs: [run({ state: 'waiting', question: { question: 'Go?', options: ['yes'] } })] });
        paste(text);
        readers[0].finish();
        part('send').click();
        assert.match(notes[0].text, /An answer takes no pictures/);
        assert.equal(calls.filter((c) => c.type === 'control').length, 0);
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

    it('agent text renders as markdown, sanitized, and other bubbles stay plain text', async () => {
        const { part, receive } = await popup({});
        receive('event', event('prompt', '**you**'));
        receive('event', event('question', '**ask**'));
        receive('event', event('text', '**bold**<script>x</script>'));
        const [you, question, agent] = part('list').childNodes.map((m) => m.childNodes[1]);
        for (const b of [you, question]) assert.equal(b.innerHTML, undefined);
        assert.equal(you.textContent, '**you**');
        assert.equal(question.textContent, 'Question: **ask**');
        assert.ok(agent.classList.contains('ca-md'));
        assert.equal(agent.innerHTML, '<md>**bold**</md>');
    });

    it('a link of agent text opens in a new tab, in live and loaded entries', async () => {
        const markdown = '<a href="x">l</a>';
        const live = await popup({});
        live.receive('event', event('text', markdown));
        const loaded = await popup({ events: [event('text', markdown)] });
        for (const { part } of [live, loaded]) {
            const [a] = part('list').childNodes[0].childNodes[1].found.a;
            assert.equal(a.attributes.target, '_blank');
            assert.equal(a.attributes.rel, 'noopener noreferrer');
        }
    });

    it('the sanitizer config forbids each tag and attribute that loads a remote file', async () => {
        const { receive, sanitized } = await popup({});
        receive('event', event('text', 'x'));
        const [config] = sanitized;
        for (const tag of ['img', 'picture', 'source', 'video', 'audio', 'iframe', 'style']) assert.ok(config.FORBID_TAGS.includes(tag), tag);
        for (const attr of ['style', 'poster', 'srcset', 'src']) assert.ok(config.FORBID_ATTR.includes(attr), attr);
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

    it('a life cycle line of the agent shows as a marked line in the chat', async () => {
        const { part, receive } = await popup({});
        receive('event', event('life', 'keep-alive 1 of 3'));
        const [line] = part('list').childNodes;
        assert.ok(line.classList.contains('ca-end') && line.classList.contains('ca-life'));
        assert.equal(line.textContent, 'life cycle: keep-alive 1 of 3');
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

    it('the status line of a run says 1 turn, and no tokens before the result', async () => {
        const p = setup({}, { events: [], runs: [], session: { cacheTtl: '1h', lastActivity: null } });
        const status = fakeElement('div');
        status.id = 'nru_popup.n1.statusText';
        status.setStatusText = (v) => { status.textContent = v; };
        p.div.appendChild(status);
        p.receive('runs', [run({ tokens: '', context: '10' })]);
        assert.equal(status.textContent, 'running, 1 turn, context 10');
        p.receive('runs', [run({ turns: 2 })]);
        assert.equal(status.textContent, 'running, 2 turns, 1.1k tokens');
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

describe('claude-agent popup identity block', () => {
    const full = { name: 'triage', model: 'sonnet', cwd: '/work/garden', sandbox: 'pi-box' };
    const lines = (t) => [t.part('name'), t.part('about')];

    it('shows the name, model, folder and sandbox of the node', () => {
        const [name, about] = lines(setup({}, undefined, full));
        assert.equal(name.textContent, 'triage');
        assert.equal(about.textContent, 'sonnet · /work/garden · sandbox pi-box');
        assert.equal(name.title, name.textContent);
        assert.equal(about.title, about.textContent);
    });

    it('shows the defaults for a node with nothing set', () => {
        const [name, about] = lines(setup());
        assert.equal(name.textContent, 'claude-agent');
        assert.equal(about.textContent, 'default model · work root');
    });

    it('is the first child of the popup, above the tab row', () => {
        const root = walk(setup().div).find((e) => e.className === 'ca-popup');
        assert.equal(root.childNodes[0].className, 'ca-identity');
        assert.equal(root.childNodes[1].className, 'ca-header');
    });

    it('a rebuild gives exactly one identity block', () => {
        const t = setup({}, undefined, full);
        t.rebuild();
        t.rebuild();
        assert.equal(walk(t.div).filter((e) => e.className === 'ca-identity').length, 1);
    });

    it('nodes:change updates the open popup and ignores another node', () => {
        const t = setup({}, undefined, full);
        t.emit('nodes:change', { id: 'other', name: 'x', model: 'y' });
        assert.equal(t.part('name').textContent, 'triage');
        t.emit('nodes:change', { id: 'n1', name: 'audit', model: 'opus' });
        assert.equal(t.part('name').textContent, 'audit');
        assert.equal(t.part('about').textContent, 'opus · work root');
    });

    describe('model', () => {
        const about = (t) => t.part('about').textContent;
        const withModel = (fields, state) => setup({}, { events: [], runs: [], session: { cacheTtl: '1h', lastActivity: null }, ...state }, fields);

        it('shows the model of the selected run as family and version', async () => {
            const t = withModel({}, { runs: [run({ model: 'claude-opus-5-5' })] });
            await settle();
            assert.equal(about(t), 'opus 5.5 · work root');
        });

        it('shows an ID of another format in full', async () => {
            const t = withModel({}, { runs: [run({ model: 'my-model' })] });
            await settle();
            assert.equal(about(t), 'my-model · work root');
        });

        it('shows a dated ID with one version number in full, and a dated ID with two as family and version', async () => {
            const t = withModel({}, { runs: [run({ model: 'claude-opus-4-20250514' })] });
            await settle();
            assert.equal(about(t), 'claude-opus-4-20250514 · work root');
            t.receive('runs', [run({ model: 'claude-sonnet-4-5-20250929' })]);
            assert.equal(about(t), 'sonnet 4.5 · work root');
        });

        it('a line with the same text keeps its text node, so a selection stays', async () => {
            const t = withModel({}, { runs: [run({ model: 'claude-opus-5-5' })] });
            await settle();
            const line = t.part('about');
            let writes = 0;
            let text = line.textContent;
            Object.defineProperty(line, 'textContent', { get: () => text, set: (v) => { writes++; text = v; } });
            t.receive('runs', [run({ model: 'claude-opus-5-5', turns: 2 })]);
            assert.equal(writes, 0);
            t.receive('runs', [run({ model: 'claude-haiku-5-5' })]);
            assert.equal(writes, 1);
        });

        it('with no run, shows the model of the last run, and updates on a session message', async () => {
            const t = withModel({}, { session: { cacheTtl: '1h', lastActivity: null, model: 'claude-sonnet-5-5' } });
            await settle();
            assert.equal(about(t), 'sonnet 5.5 · work root');
            t.receive('session', { cacheTtl: '1h', lastActivity: null, model: 'claude-haiku-5-5' });
            assert.equal(about(t), 'haiku 5.5 · work root');
        });

        it('with no run since the start, shows the model field of the node', async () => {
            const t = withModel({ model: 'sonnet' });
            await settle();
            assert.equal(about(t), 'sonnet · work root');
        });

        it('marks a node model of another family, and not one of the same family', async () => {
            const t = withModel({ model: 'sonnet' }, { runs: [run({ model: 'claude-opus-5-5' })] });
            await settle();
            assert.equal(about(t), 'opus 5.5 (node: sonnet) · work root');
            t.receive('runs', [run({ model: 'claude-sonnet-5-5' })]);
            assert.equal(about(t), 'sonnet 5.5 · work root');
        });
    });

    it('does not throw when the popup has gone', () => {
        const t = setup({}, undefined, full);
        t.div.childNodes = [];
        assert.equal(t.part('identity'), null);
        assert.doesNotThrow(() => t.emit('nodes:change', { id: 'n1', name: 'audit' }));
    });

    it('shows a name with markup as text', () => {
        const name = '<b>x</b>&amp;';
        const t = setup({}, undefined, { name });
        assert.equal(t.part('name').textContent, name);
        assert.equal(t.part('name').title, name);
        assert.equal(t.part('name').innerHTML, undefined);
    });

    it('shows a summary as the second line, with the same title', () => {
        const t = setup({}, undefined, { ...full, summary: 'Tells you what is in its work folder' });
        const identity = walk(t.div).find((e) => e.className === 'ca-identity');
        assert.equal(identity.childNodes[1].className, 'ca-summary');
        assert.equal(t.part('summary'), identity.childNodes[1]);
        assert.equal(t.part('summary').textContent, 'Tells you what is in its work folder');
        assert.equal(t.part('summary').title, 'Tells you what is in its work folder');
        assert.notEqual(t.part('summary').style.display, 'none');
    });

    it('hides the summary line for an old flow and for a summary of spaces', () => {
        for (const summary of [undefined, '   ']) {
            const t = setup({}, undefined, { ...full, summary });
            assert.equal(t.part('summary').style.display, 'none');
            assert.equal(t.part('name').textContent, 'triage');
            assert.equal(t.part('about').textContent, 'sonnet · /work/garden · sandbox pi-box');
        }
    });

    it('never shows the system prompt', () => {
        const t = setup({}, undefined, { ...full, systemPrompt: 'SECRET-TOKEN-123 You pick colours.' });
        assert.equal(t.part('summary').style.display, 'none');
        const all = walk(t.div).map((e) => (e.textContent || '') + (e.title || '')).join('|');
        assert.ok(!all.includes('SECRET-TOKEN-123'));
    });

    it('shows a summary with markup as text', () => {
        const summary = '<b>x</b>&amp;';
        const t = setup({}, undefined, { summary });
        assert.equal(t.part('summary').textContent, summary);
        assert.equal(t.part('summary').title, summary);
        assert.equal(t.part('summary').innerHTML, undefined);
    });

    it('nodes:change shows, changes and hides the summary', () => {
        const t = setup({}, undefined, full);
        assert.equal(t.part('summary').style.display, 'none');
        t.emit('nodes:change', { id: 'n1', name: 'triage', summary: 'One' });
        assert.equal(t.part('summary').textContent, 'One');
        assert.notEqual(t.part('summary').style.display, 'none');
        t.emit('nodes:change', { id: 'n1', name: 'triage', summary: 'Two' });
        assert.equal(t.part('summary').textContent, 'Two');
        t.emit('nodes:change', { id: 'n1', name: 'triage', summary: '' });
        assert.equal(t.part('summary').textContent, '');
        assert.equal(t.part('summary').style.display, 'none');
    });

    it('keeps each line on one row with an ellipsis', () => {
        const css = walk(setup().head).map((e) => e.textContent).join('');
        for (const rule of ['.ca-name', '.ca-summary', '.ca-about']) {
            const m = new RegExp(rule.replace('.', '\\.') + '\\{([^}]*)\\}').exec(css);
            assert.match(m[1], /white-space:\s*nowrap/);
            assert.match(m[1], /text-overflow:\s*ellipsis/);
        }
    });

    it('has style rules with no fixed colour', () => {
        const t = setup();
        const css = walk(t.head).map((e) => e.textContent).join('');
        for (const rule of ['.ca-identity', '.ca-name', '.ca-summary', '.ca-about']) {
            const m = new RegExp(rule.replace('.', '\\.') + '\\{([^}]*)\\}').exec(css);
            assert.ok(m, rule);
            assert.ok(!/#[0-9a-f]{3,6}|rgb/i.test(m[1]), rule);
        }
    });
});

describe('claude-agent edit dialog', () => {
    it('has a title and a description before the Name row', () => {
        const template = /data-template-name="claude-agent">([\s\S]*?)<\/script>/.exec(html)[1];
        const head = template.indexOf('id="claude-agent-header"');
        assert.ok(head >= 0 && head < template.indexOf('node-input-name'));
        assert.ok(template.includes('>Claude agent</div>'));
        assert.ok(template.includes('A claude-agent node that runs one Claude Code agent for each start message.'));
    });

    it('has a Summary input after Name, with a limit, and the button', () => {
        const template = /data-template-name="claude-agent">([\s\S]*?)<\/script>/.exec(html)[1];
        const summary = template.indexOf('id="node-input-summary"');
        assert.ok(summary > template.indexOf('node-input-name'));
        assert.match(template.slice(summary, template.indexOf('>', summary)), /maxlength="120"/);
        assert.ok(template.includes('id="claude-agent-summary-from-prompt"'));
        assert.equal(setup().getDef().defaults.summary.value, '');
    });

    it('accepts a node that was saved before the life cycle fields', () => {
        const defaults = setup().getDef().defaults;
        for (const field of ['contextLimit', 'maxKeepAlive']) {
            assert.equal(defaults[field].validate(undefined), true, field);
            assert.equal(defaults[field].validate('x'), false, field);
        }
    });

    const click = (prompt) => {
        const set = [];
        let handler;
        const $ = (sel) => {
            const e = {
                val: (v) => (v === undefined ? prompt : (set.push([sel, v]), e)),
                on: (ev, fn) => { if (sel === '#claude-agent-summary-from-prompt' && ev === 'click') handler = fn; return e; },
                trigger: () => e,
                toggle: () => e
            };
            return e;
        };
        const t = setup({ $ });
        t.getDef().oneditprepare.call({ cacheTtl: '1h' });
        set.length = 0;
        handler();
        return { set, notes: t.notes };
    };

    it('the button copies the start of the unsaved system prompt', () => {
        const { set, notes } = click('# You pick colours. Ask first.\nMore.');
        assert.deepEqual(set, [['#node-input-summary', 'You pick colours.']]);
        assert.deepEqual(notes, []);
    });

    it('the button warns and leaves the field when the prompt is empty', () => {
        const { set, notes } = click('  ');
        assert.deepEqual(set, []);
        assert.deepEqual(notes, [{ text: 'The system prompt is empty.', type: 'warning' }]);
    });
});

describe('claude-agent summaryFromPrompt', () => {
    const f = (t) => setup().getDef().summaryFromPrompt(t);

    it('gives an empty text for empty and blank input', () => {
        assert.equal(f(''), '');
        assert.equal(f(undefined), '');
        assert.equal(f(' \n  \n'), '');
    });

    it('takes the first non-empty line', () => {
        assert.equal(f('\n\n  First line\nSecond line'), 'First line');
    });

    it('skips lines that have only marks', () => {
        assert.equal(f('---\nText.'), 'Text.');
        assert.equal(f('###'), '');
        assert.equal(f('# \n\n## Real title'), 'Real title');
    });

    it('stops at the first sentence', () => {
        assert.equal(f('You pick colours. Ask first.'), 'You pick colours.');
        assert.equal(f('Ready! Go.'), 'Ready!');
        assert.equal(f('Version 1.2 is used'), 'Version 1.2 is used');
    });

    it('removes markdown marks', () => {
        assert.equal(f('# Title'), 'Title');
        assert.equal(f('- an item'), 'an item');
        assert.equal(f('1. one'), 'one');
        assert.equal(f('You are **bold** and `code`'), 'You are bold and code');
    });

    it('cuts a long sentence at a word and adds an ellipsis', () => {
        const out = f('alpha '.repeat(60).trim());
        assert.ok(out.length <= 120);
        assert.ok(out.endsWith('\u2026'));
        assert.match(out.slice(0, -1), /^(alpha )*alpha$/);
    });
});

describe('claude-agent popup chat sender', () => {
    const entries = (p) => p.part('agents').childNodes;
    const long = 'line 1\nline 2\nline 3\nline 4 ' + 'x'.repeat(400);
    const at = new Date(2026, 0, 1, 9, 5).getTime();
    const events = [
        event('prompt', 'typed', { seq: 1 }),
        event('prompt', long, { seq: 2, source: 'agent', from: 'Team-B/peer', time: at }),
        event('prompt', '.', { seq: 3, source: 'life' }),
        event('sent', 'answer ' + long, { seq: 4, to: 'Team-B/peer', time: at })
    ];
    const check = (p) => {
        const chat = p.part('list').childNodes;
        assert.equal(chat.length, 1, 'the Chat has the typed text only');
        assert.match(chat[0].childNodes[0].textContent, /^You/);
        const list = entries(p);
        assert.equal(list.length, 2);
        const [card, sent] = list;
        assert.ok(card.classList.contains('ca-inbox') && !card.classList.contains('ca-op') && !card.classList.contains('ca-sent'));
        assert.equal(card.childNodes[0].textContent, 'From Team-B/peer \u00b7 09:05');
        assert.equal(card.childNodes[1].textContent, long, 'the card has the full text');
        assert.ok(!card.classList.contains('ca-open'), 'the card is closed');
        assert.ok(sent.classList.contains('ca-inbox') && sent.classList.contains('ca-sent'));
        assert.equal(sent.childNodes[0].textContent, 'To Team-B/peer \u00b7 09:05');
        assert.equal(sent.childNodes[1].textContent, 'answer ' + long);
    };

    it('the history shows an inbox message and a sent message as cards in the Agents tab, not in the Chat', async () => {
        check(await popup({ events }));
    });

    it('the live view shows the same entries', async () => {
        const p = await popup({});
        for (const e of events) p.receive('event', e);
        check(p);
    });

    it('the badge counts the live messages while the Chat shows, hides at 0, shows 99+ and clears when the tab opens', async () => {
        const p = await popup({ events });
        const badge = p.part('badge');
        assert.equal(badge.style.display, 'none', 'the history does not count');
        p.receive('event', event('prompt', 'a', { source: 'agent', from: 'T/a' }));
        p.receive('event', event('prompt', 'b', { source: 'agent', from: 'T/b' }));
        p.receive('event', event('sent', 'b', { to: 'T/a' }));
        assert.equal(badge.textContent, '2', 'a sent message does not count');
        assert.equal(badge.style.display, '');
        p.part('tab-agents').click();
        assert.equal(badge.style.display, 'none');
        p.receive('event', event('sent', 'c', { to: 'T/a' }));
        assert.equal(badge.style.display, 'none', 'a message that comes while the tab shows does not count');
        p.part('tab-chat').click();
        for (let i = 0; i < 100; i++) p.receive('event', event('prompt', 'x', { source: 'agent', from: 'T/a' }));
        assert.equal(badge.textContent, '99+');
        p.receive('cleared');
        assert.equal(badge.style.display, 'none');
        assert.equal(entries(p).length, 0);
    });

    it('a rebuilt popup keeps the count of the badge', async () => {
        const p = await popup({});
        p.receive('event', event('prompt', 'a', { source: 'agent', from: 'T/a' }));
        p.rebuild();
        assert.equal(p.part('badge').textContent, '1');
        assert.equal(p.part('badge').style.display, '');
    });

    it('the Agents tab shows with the Chat and the Timeline as tabs', async () => {
        const p = await popup({ events });
        assert.equal(p.part('agents').style.display, 'none');
        p.part('tab-agents').click();
        assert.equal(p.part('agents').style.display, 'flex');
        assert.equal(p.part('chat').style.display, 'none');
        assert.equal(p.part('log').style.display, 'none');
        assert.ok(p.part('tab-agents').classList.contains('selected'));
        p.part('tab-timeline').click();
        assert.equal(p.part('agents').style.display, 'none');
        assert.equal(p.part('log').style.display, '');
    });

    // The browser lays out the card: the text is higher than its 3 lines (long) or not
    const layout = (p, high) => {
        const text = entries(p)[0].childNodes[1];
        text.scrollHeight = high ? 200 : 50;
        text.clientHeight = 50;
        p.resize();
    };

    it('a click opens a long card and a second click closes it', async () => {
        const p = await popup({ events });
        layout(p, true);
        const card = entries(p)[0];
        assert.ok(card.classList.contains('ca-more'));
        assert.equal(card.getAttribute('role'), 'button');
        card.click();
        assert.ok(card.classList.contains('ca-open'));
        assert.equal(card.getAttribute('aria-expanded'), 'true');
        card.click();
        assert.ok(!card.classList.contains('ca-open'));
        assert.equal(card.getAttribute('aria-expanded'), 'false');
    });

    it('a short card has no toggle', async () => {
        const p = await popup({ events: [event('prompt', 'hi', { source: 'agent', from: 'T/a' })] });
        layout(p, false);
        const card = entries(p)[0];
        card.click();
        assert.ok(!card.classList.contains('ca-more'), 'no arrow, no mask');
        assert.ok(!card.classList.contains('ca-open'));
        assert.equal(card.getAttribute('role'), undefined);
    });

    it('a click that ends a text selection in the card does not toggle it', async () => {
        const p = await popup({ events });
        layout(p, true);
        const card = entries(p)[0];
        card.contains = () => true;
        p.window.getSelection = () => ({ isCollapsed: false, anchorNode: card.childNodes[1] });
        card.click();
        assert.ok(!card.classList.contains('ca-open'));
    });
});

describe('claude-agent popup text selection', () => {
    it('the whole popup selects text, shows the normal cursor, and the buttons do not select', async () => {
        const { head } = await popup({});
        const css = head.childNodes.map((c) => c.textContent).join('');
        assert.match(/\.ca-popup\{[^}]*\}/.exec(css)[0], /cursor:default;user-select:text/);
        assert.match(css, /\.ca-popup button\{user-select:none\}/);
        assert.match(css, /\.ca-name,[^{]*\.ca-bubble,[^{]*\.ca-log\{cursor:text\}/);
        assert.match(css, /\.ca-spacer\{flex:1;align-self:stretch;min-width:0\}/);
        assert.match(css, /\.ca-spacer\{cursor:move\}/);
        // Only the button rule turns the selection off
        assert.doesNotMatch(css.replace('.ca-popup button{user-select:none}', ''), /user-select:(none|auto)/);
    });

    it('only the empty part of the tab row moves the popup: it gives the mouse press to the title bar', async () => {
        const events = [];
        class MouseEvent { constructor(type, init) { Object.assign(this, { type }, init); } }
        const t = setup({ MouseEvent });
        const bar = fakeElement('rect');
        bar.id = 'nru_popup.n1.header';
        bar.dispatchEvent = (e) => events.push(e);
        t.head.childNodes.push(bar);
        const spacer = walk(t.div).find((e) => e.className === 'ca-spacer');
        let prevented = 0;
        spacer.listeners.mousedown[0]({ clientX: 7, clientY: 9, preventDefault() { prevented++; } });
        assert.deepEqual(events.map((e) => [e.type, e.clientX, e.clientY]), [['mousedown', 7, 9]]);
        assert.equal(prevented, 1);
        assert.equal(t.part('tab-chat').listeners.mousedown, undefined);
        assert.equal(t.part('log').listeners.mousedown, undefined);
    });

    it('the right button menu stays in the popup, so the browser menu has Copy', async () => {
        const { div } = await popup({});
        assert.ok(div.listeners.contextmenu.length > 0);
    });
});

describe('claude-agent popup first open', () => {
    it('the chat shows the newest message when the popup first has a size', async () => {
        const p = setup({}, { events: [event('text', 'old', { source: 'agent' })], runs: [], session: { cacheTtl: '1h', lastActivity: null } });
        await settle();
        const chat = p.part('chat');
        chat.scrollTop = 0;
        chat.scrollHeight = 900;
        p.resize();
        assert.equal(chat.scrollTop, 0, 'a pane with no size is not scrolled');
        chat.clientHeight = 200;
        p.resize();
        assert.equal(chat.scrollTop, 900);
        chat.clientHeight = 0;
        chat.scrollTop = 0;
        p.resize();
        chat.clientHeight = 200;
        p.resize();
        assert.equal(chat.scrollTop, 900, 'the frame hides and shows the pane again: the newest message shows again');
        chat.scrollTop = 300;
        chat.listeners.wheel[0]();
        p.resize();
        assert.equal(chat.scrollTop, 300, 'after the user scrolls, the pane keeps its place');
    });
    it('the timeline shows the newest line when the popup opens on the timeline', async () => {
        const p = setup({}, { events: [event('text', 'old', { source: 'agent' })], runs: [], session: { cacheTtl: '1h', lastActivity: null } });
        await settle();
        p.part('tab-timeline').click();
        p.rebuild();
        await settle();
        const log = p.part('log');
        log.scrollHeight = 700;
        log.clientHeight = 200;
        p.resize();
        assert.equal(log.scrollTop, 700);
    });
});
