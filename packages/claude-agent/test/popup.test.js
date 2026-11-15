'use strict';

// Runs the editor script of claude-agent.html in a small fake DOM and checks the popup message box.

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
