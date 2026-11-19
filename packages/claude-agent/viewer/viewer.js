// The viewer page: it shows one version of one artifact (docs/artifacts.md, section 5).
// The URL is /v/<ticket>/?theme=light|dark. The page reads the version from "meta", then shows the entry file.
// The renderers in renderers/ register here. The first renderer that matches a file shows it.
'use strict';

(function () {
    // Tell the editor that the view server answered, before the meta request and the render.
    // Thus a dead link page, a render error and a slow render also send it. Only data, no command.
    if (window.parent !== window) window.parent.postMessage({ type: 'loaded' }, '*');
    const renderers = [];
    const base = location.pathname.replace(/[^/]*$/, '');   // /v/<ticket>/
    const TEXT_PROBE = 8192;
    // A text file larger than this shows only its first part: a larger DOM makes the page slow
    const TEXT_LIMIT = 2 * 1024 * 1024;

    function encodePath(p) {
        return p.split('/').map(encodeURIComponent).join('/');
    }

    function el(tag, attrs, ...children) {
        const e = document.createElement(tag);
        for (const [k, v] of Object.entries(attrs || {})) {
            if (k === 'class') e.className = v;
            else if (k === 'text') e.textContent = v;
            else if (v !== null && v !== undefined && v !== false) e.setAttribute(k, v === true ? '' : v);
        }
        for (const c of children) if (c !== null && c !== undefined) e.append(c);
        return e;
    }

    function size(n) {
        if (n < 1024) return n + ' bytes';
        if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
        return (n / 1024 / 1024).toFixed(1) + ' MB';
    }

    // The version line of the top bar, for example "Version 3 · 18 Nov 2026"
    function versionText(m) {
        return 'Version ' + m.n + ' · ' + date(m.time);
    }

    function date(ms) {
        return new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
    }

    // The folder of a path, and a relative link resolved against a folder. Gives null for a link out of the artifact.
    function dir(p) {
        return p.includes('/') ? p.slice(0, p.lastIndexOf('/') + 1) : '';
    }
    function resolve(from, rel) {
        const parts = (dir(from) + rel).split('/');
        const out = [];
        for (const part of parts) {
            if (part === '..') { if (!out.length) return null; out.pop(); }
            else if (part !== '.' && part !== '') out.push(part);
        }
        return out.join('/');
    }

    // A cut at the end of bytes can split a UTF-8 character: remove up to 3 bytes of an incomplete sequence
    function cutUtf8(bytes) {
        let i = bytes.length - 1, k = 0;
        while (k < 3 && i >= 0 && (bytes[i] & 0xc0) === 0x80) { i--; k++; }
        return i >= 0 && bytes[i] >= 0xc0 ? bytes.slice(0, i) : bytes;
    }

    // A file of type application/octet-stream shows as text when its first 8 KB are valid UTF-8 with no NUL byte
    async function probeText(file) {
        if (file.type !== 'application/octet-stream') return;
        try {
            const r = await fetch(viewer.url(file.path), { headers: { Range: 'bytes=0-' + (TEXT_PROBE - 1) } });
            let bytes = new Uint8Array(await r.arrayBuffer());
            if (bytes.includes(0)) return;
            if (file.size > TEXT_PROBE) bytes = cutUtf8(bytes);
            new TextDecoder('utf-8', { fatal: true }).decode(bytes);
            file.isText = true;
        } catch (e) {
            // Not text: the "other" renderer shows it
        }
    }

    const viewer = {
        meta: null,
        theme: document.documentElement.dataset.theme ||
            (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'),
        el, size, date, versionText, resolve, dir, encodePath, TEXT_LIMIT,

        register(renderer) {
            renderers.push(renderer);
        },

        // The path of this version: /v/<ticket>/, also below a path prefix
        base,

        // The URL of a file of this version
        url(p) {
            return base + 'f/' + encodePath(p);
        },

        // The text of a file. A file larger than TEXT_LIMIT gives its first TEXT_LIMIT bytes, up to the last full line.
        async text(p) {
            const file = viewer.file(p);
            const big = file && file.size > TEXT_LIMIT;
            const r = await fetch(viewer.url(p), big ? { headers: { Range: 'bytes=0-' + (TEXT_LIMIT - 1) } } : {});
            if (!r.ok) throw new Error('HTTP ' + r.status);
            if (!big) return r.text();
            const text = new TextDecoder().decode(cutUtf8(new Uint8Array(await r.arrayBuffer())));
            const end = text.lastIndexOf('\n');
            return end > 0 ? text.slice(0, end + 1) : text;
        },

        // The note above a file that shows only its first part
        cutNote(file) {
            // The Download button of the page gives the file when the version has one file, else a zip
            return el('div', { class: 'cut-note' },
                el('span', { text: 'This shows the first ' + size(TEXT_LIMIT) + ' of ' + size(file.size) + '.' }),
                viewer.meta.files.length > 1
                    ? el('a', { class: 'button', href: viewer.url(file.path), download: file.path.split('/').pop(), text: 'Download this file' }) : '');
        },

        file(p) {
            return viewer.meta.files.find(f => f.path === p) || null;
        },

        // Opens another file of this version in the viewer. The path goes in the hash: the page has no state.
        open(p, anchor) {
            const h = '#file=' + encodeURIComponent(p) + (anchor ? '&at=' + encodeURIComponent(anchor) : '');
            if (location.hash === h) show();
            else location.hash = h;
        },

        // The message when a file cannot show: one line and Download
        fallback(box, file, text) {
            box.replaceChildren(el('div', { class: 'other' },
                el('div', { text: text || 'This file cannot show here.' }),
                el('a', { class: 'button', href: viewer.url(file.path), download: file.path.split('/').pop(), text: 'Download' })));
        },

        // Finds the renderer for a file
        async pick(file) {
            await probeText(file);
            return renderers.find(r => r.match(file));
        },

        // Shows one file in a box with the first renderer that matches
        async renderInto(box, file, ctx) {
            const r = await viewer.pick(file);
            try {
                await r.render(box, file, Object.assign({ url: viewer.url, text: viewer.text, theme: viewer.theme }, ctx));
                if (r.cuts && file.size > TEXT_LIMIT) box.prepend(viewer.cutNote(file));
            } catch (e) {
                viewer.fallback(box, file);
            }
        },

        // Shows one file with the renderer of this name, for example the text of a file that did not parse
        renderWith(name, box, file, ctx) {
            return renderers.find(r => r.name === name).render(box, file, ctx);
        }
    };
    window.viewer = viewer;

    function hashParams() {
        return new URLSearchParams(location.hash.slice(1));
    }

    // Under 600 px the file list is closed. A button with the name of the open file opens it.
    const narrow = matchMedia('(max-width: 599px)');

    function setListOpen(open) {
        document.getElementById('files').classList.toggle('open', open);
        document.getElementById('files-toggle').setAttribute('aria-expanded', String(open));
    }

    function fileList(current) {
        const nav = document.getElementById('files');
        const toggle = document.getElementById('files-toggle');
        if (viewer.meta.files.length < 2) return;
        nav.hidden = false;
        toggle.hidden = false;
        toggle.replaceChildren(el('span', { class: 'secondary', text: 'Files' }),
            el('span', { class: 'files-current', text: current || '' }), el('span', { 'aria-hidden': 'true', text: '▾' }));
        nav.replaceChildren(...viewer.meta.files.map(f => {
            const a = el('a', { href: '#file=' + encodeURIComponent(f.path), title: f.path, text: f.path });
            if (f.path === current) a.setAttribute('aria-current', 'true');
            return a;
        }));
    }

    // A page of a site in the frame tells its path (AT_SCRIPT of the view server). The mark and the hash follow it.
    // Only the frame of the open HTML file counts, and only a path of the file list.
    function onFrameMessage(e) {
        const frame = document.querySelector('#content > .box > iframe.frame');
        const d = e.data;
        if (!frame || e.source !== frame.contentWindow || !d || d.type !== 'claude-agent:at' || typeof d.path !== 'string') return;
        const prefix = base + 'f/';
        if (!d.path.startsWith(prefix)) return;
        let p;
        try { p = d.path.slice(prefix.length).split('/').map(decodeURIComponent).join('/'); } catch (err) { return; }
        if (!viewer.file(p)) return;
        // replaceState fires no hashchange, so the frame does not load again
        history.replaceState(null, '', '#file=' + encodeURIComponent(p));
        fileList(p);
    }

    async function show() {
        const content = document.getElementById('content');
        const h = hashParams();
        const file = viewer.file(h.get('file') || '') || viewer.file(viewer.meta.entry) || viewer.meta.files[0];
        fileList(file && file.path);
        if (viewer.compare && new URLSearchParams(location.search).get('compare')) {
            await viewer.compare(content, file);
        } else if (!file) {
            content.replaceChildren(el('div', { class: 'hint', text: 'This version has no files.' }));
        } else {
            const box = el('div', { class: 'box' });
            content.replaceChildren(box);
            await viewer.renderInto(box, file, { anchor: h.get('at') });
        }
    }

    async function main() {
        try {
            const r = await fetch(base + 'meta');
            if (!r.ok) throw new Error('HTTP ' + r.status);
            viewer.meta = await r.json();
        } catch (e) {
            // The same text as the dead link page of the view server
            document.title = 'Link not valid';
            document.body.replaceChildren(el('div', { class: 'dead' }, el('h1', { text: 'Link not valid' }),
                el('p', { text: 'This link does not work. It may have expired. Ask the sender for a new link.' })));
            return;
        }
        const m = viewer.meta;
        document.title = m.title;
        document.getElementById('title').textContent = m.title;
        document.getElementById('title').title = m.title;
        document.getElementById('version').textContent = versionText(m);
        // The agent line of a view link. The share server sends no owner and no editor, so a share page shows none.
        if (m.owner) {
            document.getElementById('owner').textContent = 'By ' + m.owner;
            document.getElementById('owner').title = m.owner;
            if (typeof m.editor === 'string' && /^https?:\/\//.test(m.editor)) {
                document.getElementById('editor').href = m.editor;
                document.getElementById('editor-link').hidden = false;
            }
            document.getElementById('agent').hidden = false;
            document.querySelector('.bar').classList.add('has-agent');
        }
        // The note of the version ("what is new"). The share server sends no note, so a share page shows none.
        if (m.note) {
            document.getElementById('note-text').textContent = m.note;
            document.getElementById('note').hidden = false;
        }
        document.getElementById('files-toggle').addEventListener('click', () =>
            setListOpen(document.getElementById('files-toggle').getAttribute('aria-expanded') !== 'true'));
        // On a narrow screen, a choice in the list closes the list
        document.getElementById('files').addEventListener('click', (e) => {
            if (narrow.matches && e.target.closest('a')) setListOpen(false);
        });
        window.addEventListener('message', onFrameMessage);
        window.addEventListener('hashchange', show);
        await show();
    }

    document.addEventListener('DOMContentLoaded', main);
})();
