'use strict';

// Runs the popup code of agent-watch.html in a fake DOM and checks how the popup handles events.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const STOPPED = ['mousedown', 'click', 'dblclick', 'touchstart', 'touchend', 'keydown', 'keyup', 'keypress', 'wheel',
    'contextmenu', 'dragenter', 'dragover', 'drop'];

function fakeElement(tag) {
    const el = {
        tag, style: { cssText: '' }, childNodes: [], listeners: [], textContent: '', id: '',
        appendChild(c) { this.childNodes.push(c); return c; },
        removeChild(c) { this.childNodes = this.childNodes.filter(x => x !== c); },
        addEventListener(type, fn) { this.listeners.push({ type, fn }); }
    };
    return el;
}

function load() {
    const html = fs.readFileSync(path.join(__dirname, '..', 'agent-watch.html'), 'utf8');
    const blocks = [...html.matchAll(/<script type="text\/javascript">([\s\S]*?)<\/script>/g)];
    assert.equal(blocks.length, 1);
    const defs = {};
    const popupDiv = fakeElement('div');
    const divs = { 'nru_popup.n1.div': popupDiv };
    const dispatched = [];
    const document = {
        getElementById: (id) => divs[id] || null,
        createElement: fakeElement,
        dispatchEvent: (e) => dispatched.push(e)
    };
    class MouseEvent { constructor(type, init) { this.type = type; Object.assign(this, init); } }
    vm.runInNewContext(blocks[0].code || blocks[0][1], {
        RED: { nodes: { registerType: (name, def) => { defs[name] = def; } } },
        document, MouseEvent, console
    });
    const def = Object.values(defs)[0];
    const node = {
        id: 'n1',
        nodeRedEditorComms: { publish: () => Promise.resolve({ lines: [], total: 0, weighted: 0 }) }
    };
    return { def, node, popupDiv, dispatched, divs };
}

function fakeEvent(init) {
    const e = { stopped: 0, prevented: 0, ...init };
    e.stopPropagation = () => { e.stopped++; };
    e.preventDefault = () => { e.prevented++; };
    return e;
}

describe('agent-watch popup', () => {
    it('makes the list selectable', () => {
        const { def, node, popupDiv } = load();
        def.nru_popupInit.call(node);
        const list = popupDiv.childNodes[0];
        assert.match(list.style.cssText, /(^|;)user-select:text;/);
        assert.equal(list.tabIndex, -1);
    });

    it('stops the events and never prevents the default', () => {
        const { def, node, popupDiv } = load();
        def.nru_popupInit.call(node);
        for (const type of STOPPED) {
            const found = popupDiv.listeners.filter(l => l.type === type);
            assert.equal(found.length, 1, type);
            const e = fakeEvent({});
            found[0].fn(e);
            assert.equal(e.stopped, 1, type);
            assert.equal(e.prevented, 0, type);
        }
    });

    it('gives the mouseup to the document', () => {
        const { def, node, popupDiv, dispatched } = load();
        def.nru_popupInit.call(node);
        const found = popupDiv.listeners.filter(l => l.type === 'mouseup');
        assert.equal(found.length, 1);
        const e = fakeEvent({ clientX: 12, clientY: 34, button: 0 });
        found[0].fn(e);
        assert.equal(e.stopped, 1);
        assert.equal(e.prevented, 0);
        assert.equal(dispatched.length, 1);
        assert.equal(dispatched[0].type, 'mouseup');
        assert.equal(dispatched[0].clientX, 12);
        assert.equal(dispatched[0].clientY, 34);
        assert.equal(dispatched[0].button, 0);
    });

    it('adds the listeners once for each div', () => {
        const { def, node, popupDiv } = load();
        def.nru_popupInit.call(node);
        const count = popupDiv.listeners.length;
        def.nru_popupInit.call(node);
        assert.equal(popupDiv.listeners.length, count);
    });

    it('adds the listeners again on a new div', () => {
        const { def, node, popupDiv, divs } = load();
        def.nru_popupInit.call(node);
        const fresh = fakeElement('div');
        divs['nru_popup.n1.div'] = fresh;
        assert.notEqual(fresh, popupDiv);
        def.nru_popupInit.call(node);
        for (const type of [...STOPPED, 'mouseup']) {
            assert.equal(fresh.listeners.filter(l => l.type === type).length, 1, type);
        }
        assert.match(fresh.childNodes[0].style.cssText, /(^|;)user-select:text;/);
    });

    it('keeps the divs of two nodes apart', () => {
        const { def, node, popupDiv, divs } = load();
        const other = { ...node, id: 'n2' };
        const div2 = fakeElement('div');
        divs['nru_popup.n2.div'] = div2;
        def.nru_popupInit.call(node);
        assert.equal(div2.listeners.length, 0);
        def.nru_popupInit.call(other);
        const count = popupDiv.listeners.length;
        assert.equal(div2.listeners.length, count);
        def.nru_popupInit.call(node);
        def.nru_popupInit.call(other);
        assert.equal(popupDiv.listeners.length, count);
        assert.equal(div2.listeners.length, count);
    });
});
