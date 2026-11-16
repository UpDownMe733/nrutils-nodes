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
        tag, childNodes: [], listeners: [], textContent: '', id: '', parentNode: null,
        style: {
            cssText: '', vars: {},
            setProperty(k, v) { this.vars[k] = v; },
            getPropertyValue(k) { return this.vars[k] || ''; }
        },
        rect: { left: 0, width: 600 },
        getBoundingClientRect() { return this.rect; },
        appendChild(c) { c.parentNode = this; this.childNodes.push(c); return c; },
        removeChild(c) { this.childNodes = this.childNodes.filter(x => x !== c); },
        addEventListener(type, fn) { this.listeners.push({ type, fn }); },
        fire(type, e) { for (const l of this.listeners.filter(x => x.type === type)) l.fn(e); }
    };
    return el;
}

function findById(el, id) {
    if (el.id === id) return el;
    for (const c of el.childNodes) {
        const f = findById(c, id);
        if (f) return f;
    }
    return null;
}

function load() {
    const html = fs.readFileSync(path.join(__dirname, '..', 'agent-watch.html'), 'utf8');
    const blocks = [...html.matchAll(/<script type="text\/javascript">([\s\S]*?)<\/script>/g)];
    assert.equal(blocks.length, 1);
    const defs = {};
    const popupDiv = fakeElement('div');
    const divs = { 'nru_popup.n1.div': popupDiv };
    const dispatched = [];
    const docListeners = [];
    const store = {};
    const localStorage = {
        getItem: (k) => (k in store ? store[k] : null),
        setItem: (k, v) => { store[k] = String(v); },
        removeItem: (k) => { delete store[k]; }
    };
    const document = {
        getElementById: (id) => {
            if (divs[id]) return divs[id];
            const m = /^agent-watch-list-(.+)$/.exec(id);
            if (m && divs['nru_popup.' + m[1] + '.div']) return findById(divs['nru_popup.' + m[1] + '.div'], id);
            return null;
        },
        createElement: fakeElement,
        dispatchEvent: (e) => dispatched.push(e),
        addEventListener: (type, fn) => docListeners.push({ type, fn }),
        removeEventListener: (type, fn) => {
            const i = docListeners.findIndex(l => l.type === type && l.fn === fn);
            if (i >= 0) docListeners.splice(i, 1);
        }
    };
    class MouseEvent { constructor(type, init) { this.type = type; Object.assign(this, init); } }
    vm.runInNewContext(blocks[0].code || blocks[0][1], {
        RED: { nodes: { registerType: (name, def) => { defs[name] = def; } } },
        document, MouseEvent, localStorage, console
    });
    const def = Object.values(defs)[0];
    const node = {
        id: 'n1',
        nodeRedEditorComms: { publish: () => Promise.resolve({ lines: [], total: 0, weighted: 0 }) }
    };
    return { def, node, popupDiv, dispatched, divs, docListeners, store, localStorage };
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
        const list = findById(popupDiv, 'agent-watch-list-n1');
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
        assert.match(findById(fresh, 'agent-watch-list-n1').style.cssText, /(^|;)user-select:text;/);
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

    describe('header and stage column', () => {
        const wrapperOf = (div) => div.childNodes[0];
        const handleOf = (div) => wrapperOf(div).childNodes[0].childNodes[1].childNodes[0];
        const doc = (h, type) => h.docListeners.filter(l => l.type === type);
        const line = (stage) => ({ time: 0, stage, level: 'info', text: 'x' });
        const add = (h, node, stage) => h.def.nodeRedEditorComms_subscriptions.line.call(node, line(stage));
        const width = (div) => wrapperOf(div).style.getPropertyValue('--aw-stage-w');

        it('has a header with Time, Stage and Line that cannot be selected', () => {
            const h = load();
            h.def.nru_popupInit.call(h.node);
            const header = wrapperOf(h.popupDiv).childNodes[0];
            assert.deepEqual(header.childNodes.map(c => c.textContent), ['Time', 'Stage', 'Line']);
            assert.match(header.style.cssText, /user-select:none/);
            assert.match(wrapperOf(h.popupDiv).childNodes[1].id, /^agent-watch-list-n1$/);
        });

        it('fits the width to the longest stage name and stops at 30ch', () => {
            const h = load();
            h.def.nru_popupInit.call(h.node);
            assert.equal(width(h.popupDiv), '6ch');
            add(h, h.node, 'draft');
            assert.equal(width(h.popupDiv), '6ch');
            add(h, h.node, 'kitchen-lights-plan-reviewer');
            assert.equal(width(h.popupDiv), '29ch');
            add(h, h.node, 'x'.repeat(50));
            assert.equal(width(h.popupDiv), '30ch');
            add(h, h.node, 'a');
            assert.equal(width(h.popupDiv), '30ch');
        });

        it('starts a drag on the handle and stops the event', () => {
            const h = load();
            h.def.nru_popupInit.call(h.node);
            const e = fakeEvent({});
            handleOf(h.popupDiv).fire('mousedown', e);
            assert.equal(e.stopped, 1);
            assert.equal(e.prevented, 1);
            assert.equal(doc(h, 'mousemove').length, 1);
            assert.equal(doc(h, 'mouseup').length, 1);
        });

        it('sets the width on a move, with the clamp', () => {
            const h = load();
            h.def.nru_popupInit.call(h.node);
            handleOf(h.popupDiv).fire('mousedown', fakeEvent({}));
            const stageCell = wrapperOf(h.popupDiv).childNodes[0].childNodes[1];
            stageCell.rect = { left: 50, width: 100 };
            const move = doc(h, 'mousemove')[0].fn;
            move({ clientX: 200 });
            assert.equal(width(h.popupDiv), '150px');
            move({ clientX: 51 });
            assert.equal(width(h.popupDiv), '40px');
            move({ clientX: 5000 });
            assert.equal(width(h.popupDiv), '360px');
            add(h, h.node, 'x'.repeat(50));
            assert.equal(width(h.popupDiv), '360px');
        });

        it('ends the drag on a mouseup and saves the width', () => {
            const h = load();
            h.def.nru_popupInit.call(h.node);
            handleOf(h.popupDiv).fire('mousedown', fakeEvent({}));
            doc(h, 'mousemove')[0].fn({ clientX: 120 });
            doc(h, 'mouseup')[0].fn({});
            assert.equal(doc(h, 'mousemove').length, 0);
            assert.equal(doc(h, 'mouseup').length, 0);
            assert.equal(h.store['agent-watch.stageWidth'], '120');
        });

        it('ends the drag on a mouseup that the popup gives to the document', () => {
            const h = load();
            h.def.nru_popupInit.call(h.node);
            handleOf(h.popupDiv).fire('mousedown', fakeEvent({}));
            h.popupDiv.fire('mouseup', fakeEvent({ clientX: 1, clientY: 2, button: 0 }));
            // The fake document gives the re-dispatched event to its mouseup listeners.
            for (const l of doc(h, 'mouseup')) l.fn(h.dispatched[0]);
            assert.equal(doc(h, 'mouseup').length, 0);
            assert.equal(doc(h, 'mousemove').length, 0);
        });

        it('uses a saved width on the next popup and stops the auto fit', () => {
            const h = load();
            h.store['agent-watch.stageWidth'] = '90';
            h.def.nru_popupInit.call(h.node);
            assert.equal(width(h.popupDiv), '90px');
            add(h, h.node, 'x'.repeat(25));
            assert.equal(width(h.popupDiv), '90px');
        });

        it('works when the storage fails', () => {
            const h = load();
            h.localStorage.getItem = () => { throw new Error('blocked'); };
            h.localStorage.setItem = () => { throw new Error('blocked'); };
            h.def.nru_popupInit.call(h.node);
            handleOf(h.popupDiv).fire('mousedown', fakeEvent({}));
            doc(h, 'mousemove')[0].fn({ clientX: 100 });
            doc(h, 'mouseup')[0].fn({});
            assert.equal(width(h.popupDiv), '100px');
        });

        it('goes back to the auto fit on a double-click', () => {
            const h = load();
            h.store['agent-watch.stageWidth'] = '90';
            h.def.nru_popupInit.call(h.node);
            add(h, h.node, 'x'.repeat(12));
            handleOf(h.popupDiv).fire('dblclick', fakeEvent({}));
            assert.equal('agent-watch.stageWidth' in h.store, false);
            assert.equal(width(h.popupDiv), '13ch');
        });

        it('gives each row a Time cell of 5ch and a Stage cell that uses the variable', () => {
            const h = load();
            h.def.nru_popupInit.call(h.node);
            add(h, h.node, 'draft');
            const row = findById(h.popupDiv, 'agent-watch-list-n1').childNodes[0];
            assert.match(row.childNodes[0].style.cssText, /(^|;)width:5ch(;|$)/);
            assert.match(row.childNodes[1].style.cssText, /(^|;)width:var\(--aw-stage-w\)(;|$)/);
        });

        it('computes the auto width again from the lines of get-log on a rebuild', async () => {
            const h = load();
            h.def.nru_popupInit.call(h.node);
            add(h, h.node, 'kitchen-lights-plan-reviewer');
            assert.equal(width(h.popupDiv), '29ch');
            // The real textContent = '' empties the div. The fake does not.
            h.popupDiv.childNodes = [];
            const lines = [line('abcdefgh'), line('abc')];
            h.node.nodeRedEditorComms.publish = () => Promise.resolve({ lines, total: 0, weighted: 0 });
            h.def.nru_popupInit.call(h.node);
            assert.equal(width(h.popupDiv), '6ch');
            await new Promise(resolve => setImmediate(resolve));
            assert.equal(width(h.popupDiv), '9ch');
            assert.equal(findById(h.popupDiv, 'agent-watch-list-n1').childNodes.length, 2);
        });

        it('limits the width to 60% of the wrapper', () => {
            const h = load();
            h.def.nru_popupInit.call(h.node);
            wrapperOf(h.popupDiv).rect = { left: 0, width: 1000 };
            handleOf(h.popupDiv).fire('mousedown', fakeEvent({}));
            doc(h, 'mousemove')[0].fn({ clientX: 900 });
            assert.equal(width(h.popupDiv), '600px');
        });

        it('keeps the widths of two nodes apart', () => {
            const h = load();
            const other = { ...h.node, id: 'n2' };
            const div2 = fakeElement('div');
            h.divs['nru_popup.n2.div'] = div2;
            h.def.nru_popupInit.call(h.node);
            h.def.nru_popupInit.call(other);
            add(h, h.node, 'x'.repeat(20));
            add(h, other, 'abc');
            assert.equal(width(h.popupDiv), '21ch');
            assert.equal(width(div2), '6ch');
        });
    });
});
