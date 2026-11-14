'use strict';

// Runs the editor script of claude-agent.html in a small fake DOM and checks the popup message box.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'claude-agent.html'), 'utf8');
const script = /<script type="text\/javascript">([\s\S]*?)<\/script>/.exec(html)[1];

function setup() {
    const byId = {};
    const listeners = (e) => (e.listeners = e.listeners || {});
    const createElement = (tag) => {
        const e = {
            tagName: tag.toUpperCase(), style: {}, childNodes: [], textContent: '', value: '', clicks: 0,
            classList: { toggle() {} },
            addEventListener(type, fn) { (listeners(e)[type] = listeners(e)[type] || []).push(fn); },
            appendChild(c) { e.childNodes.push(c); return c; },
            removeChild(c) { e.childNodes.splice(e.childNodes.indexOf(c), 1); },
            click() { e.clicks++; (listeners(e).click || []).forEach((fn) => fn({ stopPropagation() {} })); }
        };
        return e;
    };
    const document = {
        createElement,
        getElementById: (id) => byId[id] || null
    };
    // An element is found by id once it has one: look through the created tree.
    const div = createElement('div');
    byId['nru_popup.n1.div'] = div;
    const all = [];
    document.createElement = (tag) => {
        const e = createElement(tag);
        all.push(e);
        return e;
    };
    document.getElementById = (id) => byId[id] || all.find((e) => e.id === id) || null;
    let def;
    const calls = [];
    const RED = {
        nodes: { registerType: (name, d) => { def = d; } },
        notify() {},
        validators: { number: () => () => true },
        settings: {}
    };
    vm.runInNewContext(script, { document, RED, window: {} });
    const node = {
        id: 'n1',
        nodeRedEditorComms: { publish: (type, payload) => { calls.push({ type, payload }); return Promise.resolve({ events: [], runs: [] }); } }
    };
    def.nru_popupInit.call(node);
    const text = document.getElementById('claude-agent-text-n1');
    return { text, calls };
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
