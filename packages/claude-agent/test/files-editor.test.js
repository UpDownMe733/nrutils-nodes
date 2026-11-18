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

    it('ago gives a short age', () => {
        const ago = fn('ago');
        assert.equal(ago(Date.now()), 'just now');
        assert.equal(ago(Date.now() - 5 * 60000), '5 min ago');
        assert.equal(ago(Date.now() - 3 * 3600000), '3 h ago');
        assert.equal(ago(Date.now() - 2 * 86400000), '2 d ago');
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
});
