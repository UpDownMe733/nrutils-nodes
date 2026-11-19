'use strict';

// Checks the pure functions of the Files script block of claude-agent.html.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'claude-agent.html'), 'utf8');
const block = [...html.matchAll(/<script type="text\/javascript">([\s\S]*?)<\/script>/g)].map((m) => m[1]).find((s) => s.includes('window.caFiles = '));

// Cut the source of one function out of the block and run it
function fn(name, ...deps) {
    const source = (n) => new RegExp('^    function ' + n + '\\([^)]*\\) \\{[\\s\\S]*?^    \\}$', 'm').exec(block)[0];
    const context = vm.createContext({ Date });
    vm.runInContext([name, ...deps].map(source).join('\n'), context);
    return context[name];
}

describe('Files script block', () => {
    it('is in the page', () => assert.ok(block));

    it('sizeText gives a unit and one decimal for KB and more', () => {
        const sizeText = fn('sizeText');
        assert.equal(sizeText(0), '0 B');
        assert.equal(sizeText(1536), '1.5 KB');
        assert.equal(sizeText(5 * 1024 * 1024), '5.0 MB');
    });

    it('stampText gives the clock time for today and the date for an earlier day', () => {
        const source = ['clockText', 'dateText', 'stampText'].map((n) => new RegExp('^    function ' + n + '\\([^)]*\\) \\{[\\s\\S]*?^    \\}$', 'm').exec(block)[0]).join('\n');
        const context = vm.createContext({ Date, String });
        vm.runInContext(source, context);
        const today = new Date();
        today.setHours(9, 5, 0, 0);
        assert.equal(context.stampText(today.getTime()), '09:05');
        assert.match(context.stampText(Date.now() - 3 * 864e5), /^\d{1,2} \w+ \d\d:\d\d$/);
    });

    it('isNew compares the server time with the stored time and the opened files', () => {
        const store = {};
        const context = vm.createContext({
            JSON, SEEN_KEY: 's', OPENED_KEY: 'o',
            localStorage: { getItem: (k) => store[k] || null, setItem: (k, v) => { store[k] = v; } }
        });
        const source = (n) => new RegExp('^    function ' + n + '\\([^)]*\\) \\{[\\s\\S]*?^    \\}$', 'm').exec(block)[0];
        vm.runInContext(['stored', 'isNew'].map(source).join('\n'), context);
        const item = { id: 'a', nodeId: 'n', time: 100 };
        assert.equal(context.isNew(item), true);
        store.s = JSON.stringify({ n: 100 });
        assert.equal(context.isNew(item), false);
        assert.equal(context.isNew({ ...item, time: 101 }), true);
        store.o = JSON.stringify({ a: 101 });
        assert.equal(context.isNew({ ...item, time: 101 }), false);
        assert.equal(context.isNew({ ...item, time: 102 }), true);
    });

    it('has the round 2 corrections: focus, ring, filters, new mark, touch labels, auto full screen', () => {
        assert.match(html, /show-files-tab', \(\) => \{ RED\.sidebar\.show\('claude-agent-files'\); setTimeout/);
        assert.match(html, /show-agent-tab', \(\) => \{ RED\.sidebar\.show\('claude-agent'\); setTimeout/);
        assert.match(html, /\.caf \.caf-icon:focus-visible\{outline:2px solid/);
        assert.match(html, /\.caf \.caf-filters select\{flex:1 1 auto;min-width:fit-content\}/);
        assert.match(html, /tabButton\.toggleClass\('caf-tabnew', total > 0\)/);
        assert.match(html, /@media \(hover:none\)\{\.caf \.caf-icon \.caf-label\{display:inline !important\}/);
        assert.match(html, /if \(!on && auto\) \{\n\s+const id = cur\.id;\n\s+close\(\);\n\s+const row = list\.querySelector/);
        assert.match(html, /pane\.offsetParent && !pane\.classList\.contains\('caf-full'\) && body\.getBoundingClientRect\(\)\.height < 120/);
    });

    it('has the Files shortcuts, the sort, the Escape rule and the copy link text', () => {
        assert.match(html, /RED\.keyboard\.add\('\*', 'ctrl-g f', 'claude-agent:show-files-tab'\)/);
        assert.match(html, /RED\.keyboard\.add\('\*', 'ctrl-g a', 'claude-agent:show-agent-tab'\)/);
        assert.match(html, /action: 'claude-agent:show-files-tab'/);
        assert.match(html, /action: 'claude-agent:show-agent-tab'/);
        assert.match(block, /\['size', 'Largest'\]/);
        assert.match(block, /e\.stopPropagation\(\);\n\s+setFull\(false\)/);
        assert.match(block, /Anyone with this link can open this version for 12 hours/);
        assert.doesNotMatch(block, /caf-menu|'More'/);
    });

    describe('the Files page', () => {
        const source = (n) => new RegExp('^    function ' + n + '\\([^)]*\\) \\{[\\s\\S]*?^    \\}$', 'm').exec(block)[0];
        const context = vm.createContext({ ID: /^[0-9a-f]{16}$/, Number, atob, String });
        vm.runInContext(['ref', 'parseHash', 'ticketRef'].map(source).join('\n'), context);
        const id = '0123456789abcdef';
        const ticket = (payload) => Buffer.from(payload).toString('base64url') + '.' + 'c2ln';

        it('reads #files and #files/<id>/<n>', () => {
            assert.deepEqual({ ...context.parseHash('#files') }, {});
            assert.deepEqual({ ...context.parseHash('#files/' + id + '/3') }, { id, n: 3 });
            assert.equal(context.parseHash('#flow/abc'), null);
            assert.equal(context.parseHash(''), null);
        });

        it('drops a bad id or version', () => {
            for (const hash of ['#files/ABCDEF0123456789/3', '#files/' + id + '/x', '#files/' + id + '/1.5', '#files/../../3', '#files/' + id + '/3/4', '#files/' + id + '/9999999']) {
                assert.ok(!context.parseHash(hash) || !context.parseHash(hash).id, hash);
            }
        });

        it('reads the id and the version from a view link or a ticket', () => {
            const t = ticket(id + '|4|99999');
            assert.deepEqual({ ...context.ticketRef(t) }, { id, n: 4 });
            assert.deepEqual({ ...context.ticketRef('http://host:1881/v/' + t + '/?theme=dark') }, { id, n: 4 });
            assert.equal(context.ticketRef(ticket('../etc|4|9')), null);
            assert.equal(context.ticketRef(ticket(id + '|x|9')), null);
            assert.equal(context.ticketRef('report.md'), null);
            assert.equal(context.ticketRef('hello'), null);
        });

        it('has the page, the key, the menu item, the hash rules and no innerHTML from data', () => {
            assert.match(block, /const startHash = location\.hash;/);
            assert.match(block, /RED\.keyboard\.add\('\*', 'ctrl-g shift-f', 'claude-agent:show-files-page'\)/);
            assert.match(block, /RED\.menu\.addItem\('menu-item-view-menu', \{ id: 'menu-item-claude-agent-files', label: 'Files page'/);
            assert.match(block, /RED\.events\.on\('flows:loaded'[\s\S]*?openPage\(target\)/);
            assert.match(block, /RED\.events\.on\('workspace:change'/);
            assert.match(block, /RED\.nodes\.node\(nodeId\)/);
            assert.match(block, /Agent removed/);
            assert.match(block, /getElementById\('red-ui-editor'\)[\s\S]*?editor\.inert = on/);
            assert.doesNotMatch(block, /addEventListener\('focusin'/);
            assert.match(block, /getElementById\('red-ui-notifications'\)[\s\S]*?document\.body\.appendChild\(notes\)[\s\S]*?notesHome\.appendChild\(notes\)/);
            assert.match(block, /\.caf-page\{[^}]*font:var\(--red-ui-primary-font-size\) var\(--red-ui-primary-font\)[^}]*\}[\s\S]*?\.caf-full\{[^}]*font:var\(--red-ui-primary-font-size\) var\(--red-ui-primary-font\)/);
            assert.match(block, /#red-ui-notifications\{z-index:1600;[^}]*\}[\s\S]*?\.caf-full\{[^}]*z-index:1500/);
            assert.match(block, /if \(link && RED\.clipboard\.copyText[\s\S]*?The link did not copy\.', 'error'\);\s*copy\.focus\(\);/);
            assert.match(block, /e\.target !== document\.body[\s\S]*?e\.key === 'Escape' && page\.layer\.querySelector\('\.caf-full'\)[\s\S]*?e\.stopPropagation\(\);[\s\S]*?closePage\(\);[\s\S]*?page\.layer\.focus\(\);[\s\S]*?\}, true\);/);
            assert.match(html, /View &gt; Files page<\/b>[\s\S]*?Ctrl\+G Shift\+F[\s\S]*?#files[\s\S]*?Show agent<\/b>[\s\S]*?<b>Close<\/b>[\s\S]*?Escape ends full screen first/);
            assert.doesNotMatch(block, /innerHTML/);
        });
    });

    describe('the corrections of the user study round 2', () => {
        const start = block.indexOf('    // Equal sort keys');
        const code = block.slice(start, block.indexOf('    function request('));
        const make = (items) => {
            const context = vm.createContext({ Date, TYPE_NAME: { image: 'Image' }, state: { items: new Map(items.map((i) => [i.id, i])), pending: new Map() } });
            vm.runInContext(code + '\nthis.visible = visible;', context);
            return context.visible;
        };
        const item = (id, title, time, owner = 'a/b') => ({ id, title, time, owner, type: 'text/markdown', size: 1 });

        it('sorts equal times by title, then by id', () => {
            const visible = make([item('3', 'B', 5), item('2', 'B', 5), item('1', 'C', 5), item('4', 'A', 5)]);
            assert.deepEqual([...visible({}, { q: '', sort: 'time' })].map((i) => i.id), ['4', '2', '3', '1']);
            assert.deepEqual([...visible({}, { q: '', sort: 'size' })].map((i) => i.id), ['4', '2', '3', '1']);
            assert.deepEqual([...visible({}, { q: '', sort: 'name' })].map((i) => i.id), ['4', '2', '3', '1']);
        });

        it('filters by each field', () => {
            const visible = make([item('1', 'One', Date.now(), 'x/y'), item('2', 'Two', 1, 'p/q')]);
            assert.deepEqual([...visible({}, { q: '', owner: 'p/q', sort: 'time' })].map((i) => i.id), ['2']);
            assert.deepEqual([...visible({}, { q: '', time: 'today', sort: 'time' })].map((i) => i.id), ['1']);
            assert.deepEqual([...visible({}, { q: 'tw', sort: 'time' })].map((i) => i.id), ['2']);
        });

        it('has the owner filter, the cleared filters, the focus, the scroll and the names of the selects', () => {
            assert.match(block, /for \(const key of Object\.keys\(TEST\)\) if \(!TEST\[key\]\(shown, filter\)\) filter\[key\] = '';\s+if \(link && owners\) filter\.owner = shown\.owner;/);
            assert.match(block, /page\.view\.open\(target\.id, target\.n, true\)/);
            assert.match(block, /if \(focus === 'start' && !cur\.link\)/);
            assert.match(block, /page\.search\.focus\(\);\n    \}/);
            assert.match(block, /scrollIntoView\(\{ block: 'nearest' \}\)/);
            assert.match(block, /\[\[owners, 'Agent'\], \[types, 'Type'\], \[time, 'Time'\], \[sort, 'Sort'\]\]/);
            assert.match(block, /pick\.setAttribute\('aria-label', 'Version'\)/);
            assert.match(block, /\.caf-head select\{[^}]*min-width:auto/);
        });

        it('moves the pane of a popup to the body in full screen and back, and ends it when the view is gone', () => {
            assert.match(block, /if \(on && pane\.closest\('foreignObject'\)\) \{\s+pane\.replaceWith\(home\);\s+document\.body\.appendChild\(pane\);/);
            assert.match(block, /if \(home\.parentNode\) home\.replaceWith\(pane\);\s+else pane\.remove\(\);/);
            assert.match(block, /else \{\s+view\.end\(\);\s+views\.delete\(view\);/);
        });

        it('ends full screen before it shows the agent and when the popup is removed, and shows a text when the viewer sends no loaded message', () => {
            assert.match(block, /show\.addEventListener\('click', \(\) => \{ endFull\(\); showAgent\(nodeId\); \}\)/);
            assert.match(block, /e\.source !== f\.contentWindow \|\| e\.origin !== origin[^\n]*'loaded'/);
            assert.match(block, /f\.after\(note\)/);
            assert.match(block, /gone = new MutationObserver\(\(\) => \{ if \(!home\.isConnected\) setFull\(false\)/);
        });
    });

    it('itemOf shows the newest open version and hides a deleted file', () => {
        const itemOf = fn('itemOf');
        const record = (extra) => ({
            id: 'a1', name: 'report', deleted: false, owner: { address: 't/n', nodeId: 'n1' },
            versions: [
                { n: 1, title: 'Old', time: 1, entry: 'a.md', files: [{ path: 'a.md', type: 'text/markdown', size: 10 }] },
                { n: 2, title: 'New', time: 2, entry: 'a.md', files: [{ path: 'a.md', type: 'text/markdown', size: 20 }, { path: 'b.png', type: 'image/png', size: 5 }] },
                { n: 3, title: 'Gone', time: 3, deleted: true, entry: 'a.md', files: [] }
            ],
            ...extra
        });
        const item = itemOf(record());
        assert.equal(item.version, 2);
        assert.equal(item.versions, 2);
        assert.equal(item.title, 'New');
        assert.equal(item.size, 25);
        assert.equal(item.type, 'text/markdown');
        assert.equal(itemOf(record({ deleted: true })), null);
    });

    it('names each type group in the Type filter, and asks for a thumbnail of an image only', () => {
        const names = /const TYPE_NAME = \{([^}]*)\}/.exec(block)[1];
        for (const group of ['text', 'image', 'audio', 'video', 'font', 'model', 'application']) assert.match(names, new RegExp('\\b' + group + ':'));
        assert.match(block, /if \(\/\^image\\\/\/\.test\(item\.type\)\) watch\(icon, item\)/);
        assert.match(block, /t\.url \+ 'thumb'/);
    });

    it('Show agent opens the popup after the popup library has added it to the new tab', () => {
        assert.match(html, /RED\.view\.reveal\(node\.id\);[^]*?getElementById\('nru_popup\.' \+ node\.id \+ '\.group'\)\) window\.caOpenPopup\(node\);[^]*?requestAnimationFrame\(wait\)/);
    });
});
