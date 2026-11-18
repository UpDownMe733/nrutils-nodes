// Compare two versions (docs/artifacts.md, section 5). The URL is /v/<ticket>/?compare=<other ticket>.
// Text: a line diff, side by side on a wide screen, one column on a narrow screen. Images: side by side.
// Other types: the size and the SHA-256 of each version. The older version is always at the left or on top.
'use strict';

(function () {
    const MAX_CELLS = 4e6;   // the limit of the LCS table: (lines of A) x (lines of B) after the same start and end
    const CONTEXT = 3;       // the same lines that show around a change
    const NARROW = matchMedia('(max-width: 699px)');
    const el = viewer.el;

    function lines(text) {
        const t = text.replace(/\r\n?/g, '\n');
        return t === '' ? [] : t.replace(/\n$/, '').split('\n');
    }

    // The line diff: [{ op: 'same' | 'del' | 'add', a, b, text }] with the line numbers a and b (from 1),
    // or null when the changed part is too large for the LCS table.
    function diff(A, B) {
        let s = 0, ea = A.length, eb = B.length;
        while (s < ea && s < eb && A[s] === B[s]) s++;
        while (ea > s && eb > s && A[ea - 1] === B[eb - 1]) { ea--; eb--; }
        const n = ea - s, m = eb - s;
        if (n * m > MAX_CELLS) return null;
        // L[i][j]: the length of the LCS of A[s+i..ea) and B[s+j..eb)
        const w = m + 1, L = new Uint32Array((n + 1) * w);
        for (let i = n - 1; i >= 0; i--) {
            for (let j = m - 1; j >= 0; j--) {
                L[i * w + j] = A[s + i] === B[s + j] ? L[(i + 1) * w + j + 1] + 1 : Math.max(L[(i + 1) * w + j], L[i * w + j + 1]);
            }
        }
        const out = [];
        for (let k = 0; k < s; k++) out.push({ op: 'same', a: k + 1, b: k + 1, text: A[k] });
        let i = 0, j = 0;
        while (i < n || j < m) {
            if (i < n && j < m && A[s + i] === B[s + j]) { out.push({ op: 'same', a: s + i + 1, b: s + j + 1, text: A[s + i] }); i++; j++; }
            else if (i < n && (j === m || L[(i + 1) * w + j] >= L[i * w + j + 1])) { out.push({ op: 'del', a: s + i + 1, text: A[s + i] }); i++; }
            else { out.push({ op: 'add', b: s + j + 1, text: B[s + j] }); j++; }
        }
        for (let k = 0; k < A.length - ea; k++) out.push({ op: 'same', a: ea + k + 1, b: eb + k + 1, text: A[ea + k] });
        return out;
    }

    // Groups the diff into blocks: { same: [...] } or { del: [...], add: [...] }
    function blocks(ops) {
        const out = [];
        for (const o of ops) {
            let last = out[out.length - 1];
            if (o.op === 'same') {
                if (!last || !last.same) out.push(last = { same: [] });
                last.same.push(o);
            } else {
                if (!last || last.same) out.push(last = { del: [], add: [] });
                last[o.op].push(o);
            }
        }
        return out;
    }

    const num = (n, right) => el('span', { class: right ? 'd-num d-right' : 'd-num', text: n === undefined ? '' : String(n) });
    const cell = (cls, text) => el('span', { class: 'd-text ' + cls, text: text === undefined ? '' : (text || '​') });

    // One row of the diff, side by side (4 cells) or in one column (3 cells)
    function row(narrow, o, p) {
        if (narrow) {
            const cls = o.op === 'same' ? '' : o.op;
            return [num(o.a), num(o.b), cell(cls, (o.op === 'del' ? '- ' : o.op === 'add' ? '+ ' : '  ') + o.text)];
        }
        if (o && o.op === 'same') return [num(o.a), cell('', o.text), num(o.b, true), cell('', o.text)];
        return [num(o && o.a), cell(o ? 'del' : 'none', o && o.text), num(p && p.b, true), cell(p ? 'add' : 'none', p && p.text)];
    }

    function renderDiff(box, ops) {
        const narrow = NARROW.matches;
        const grid = el('div', { class: 'diff' + (narrow ? ' narrow' : '') });
        const add = (cells) => grid.append(...cells);
        const list = blocks(ops);
        list.forEach((b, k) => {
            if (b.same) {
                // Hide the middle of a long run of same lines: show CONTEXT lines next to each change
                const head = k === 0 ? 0 : CONTEXT, tail = k === list.length - 1 ? 0 : CONTEXT;
                if (b.same.length <= head + tail + 1) return b.same.forEach(o => add(row(narrow, o)));
                b.same.slice(0, head).forEach(o => add(row(narrow, o)));
                const hidden = b.same.slice(head, b.same.length - tail);
                const more = el('button', { class: 'd-more', type: 'button', text: 'Show ' + hidden.length + ' same lines' });
                more.addEventListener('click', () => {
                    const frag = document.createDocumentFragment();
                    hidden.forEach(o => frag.append(...row(narrow, o)));
                    more.replaceWith(frag);
                });
                grid.append(more);
                b.same.slice(b.same.length - tail).forEach(o => add(row(narrow, o)));
            } else if (narrow) {
                b.del.concat(b.add).forEach(o => add(row(true, o)));
            } else {
                for (let r = 0; r < Math.max(b.del.length, b.add.length); r++) add(row(false, b.del[r], b.add[r]));
            }
        });
        box.append(grid);
    }

    function caption(meta, f) {
        return 'Version ' + meta.n + (f ? ' · ' + viewer.size(f.size) : '');
    }

    function facts(old, oldFile, neu, newFile) {
        const tr = (meta, f) => el('tr', {}, el('th', { scope: 'row', text: 'Version ' + meta.n }),
            el('td', { text: f ? viewer.size(f.size) : 'Not in this version' }), el('td', { class: 'd-sha', text: f ? f.sha256 : '' }));
        return el('table', { class: 'd-facts' },
            el('thead', {}, el('tr', {}, el('th', {}), el('th', { scope: 'col', text: 'Size' }), el('th', { scope: 'col', text: 'SHA-256' }))),
            el('tbody', {}, tr(old, oldFile), tr(neu, newFile)));
    }

    const TEXT = ['text', 'markdown', 'csv', 'json', 'html'];

    viewer.diff = diff;

    viewer.compare = async (content, file) => {
        const ticket = new URLSearchParams(location.search).get('compare');
        const box = el('div', { class: 'box compare' });
        content.replaceChildren(box);
        let other;
        try {
            if (!/^[A-Za-z0-9_.-]+$/.test(ticket)) throw new Error('bad ticket');
            const r = await fetch('/v/' + ticket + '/meta');
            if (!r.ok) throw new Error('HTTP ' + r.status);
            other = await r.json();
        } catch (e) {
            return box.replaceChildren(el('div', { class: 'hint', text: 'The other version cannot load.' }));
        }
        const otherUrl = (p) => '/v/' + ticket + '/f/' + viewer.encodePath(p);
        const here = { meta: viewer.meta, file, url: viewer.url };
        const path = file ? file.path : viewer.meta.entry;
        const there = { meta: other, file: other.files.find(f => f.path === path) || null, url: otherUrl };
        const [old, neu] = here.meta.n <= there.meta.n ? [here, there] : [there, here];

        const title = el('div', { class: 'secondary', text: path + ': version ' + old.meta.n + ' and version ' + neu.meta.n });
        const tools = el('div', { class: 'tools' }, title);
        box.append(tools);
        if (!old.file || !neu.file || old.file.sha256 === neu.file.sha256) {
            const text = !old.file || !neu.file ? 'The file is not in version ' + (old.file ? neu : old).meta.n + '.' : 'The two versions of this file are the same.';
            return box.append(el('div', { class: 'other' }, el('div', { text }), facts(old.meta, old.file, neu.meta, neu.file)));
        }
        const kind = (await viewer.pick(file)).name;
        if (TEXT.includes(kind)) {
            const get = async (s) => { const r = await fetch(s.url(path)); if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); };
            let ops;
            try { ops = diff(lines(await get(old)), lines(await get(neu))); } catch (e) { ops = undefined; }
            if (!ops) {
                return box.append(el('div', { class: 'other' },
                    el('div', { text: ops === null ? 'The change is too large for a line compare.' : 'The files cannot load.' }),
                    facts(old.meta, old.file, neu.meta, neu.file)));
            }
            const added = ops.filter(o => o.op === 'add').length, removed = ops.filter(o => o.op === 'del').length;
            tools.append(el('span', { class: 'd-count' }, el('span', { class: 'd-add', text: '+' + added }), ' ', el('span', { class: 'd-del', text: '−' + removed })));
            renderDiff(box, ops);
            // The layout changes between wide and narrow: make the rows again
            NARROW.onchange = () => { box.querySelector('.diff').remove(); renderDiff(box, ops); };
        } else if (kind === 'image') {
            const fig = (s) => el('figure', {}, el('img', { src: s.url(path), alt: 'Version ' + s.meta.n }), el('figcaption', { class: 'secondary', text: caption(s.meta, s.file) }));
            box.append(el('div', { class: 'd-images' }, fig(old), fig(neu)));
        } else {
            box.append(el('div', { class: 'other' }, facts(old.meta, old.file, neu.meta, neu.file)));
        }
    };
})();
