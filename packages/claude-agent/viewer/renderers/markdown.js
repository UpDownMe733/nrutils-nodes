// Markdown: marked makes the HTML, then DOMPurify removes each script, frame, form and style.
// Relative images and links go to the files of the same artifact. An outline of the headings jumps to each part.
'use strict';

(function () {
    // HTML in markdown must not add a script, a frame, a form, or a style that covers the page
    const PURIFY = {
        FORBID_TAGS: ['style', 'form', 'input', 'button', 'textarea', 'select', 'iframe', 'frame', 'frameset',
            'object', 'embed', 'base', 'meta', 'link'],
        FORBID_ATTR: ['style', 'id', 'name', 'target', 'srcset', 'action', 'formaction']
    };
    const EXTERNAL = /^(https?:|mailto:)/i;

    // Splits "a/b.md#part" into the path and the anchor
    function split(href) {
        const i = href.indexOf('#');
        const p = (i < 0 ? href : href.slice(0, i)).replace(/\?.*$/, '');
        return { path: p, anchor: i < 0 ? '' : href.slice(i + 1) };
    }

    function slug(text, used) {
        let s = 'h-' + (text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '') || 'part');
        let id = s, k = 2;
        while (used.has(id)) id = s + '-' + k++;
        used.add(id);
        return id;
    }

    function jump(body, anchor) {
        if (!anchor) return;
        const target = body.querySelector('[id="h-' + CSS.escape(anchor) + '"]') ||
            body.querySelector('[id="' + CSS.escape(anchor) + '"]');
        if (target) target.scrollIntoView();
    }

    viewer.register({
        name: 'markdown',
        match: (file) => file.type === 'text/markdown',
        render: async (box, file, ctx) => {
            const source = await ctx.text(file.path);
            const body = viewer.el('article', { class: 'md-body' });
            body.innerHTML = DOMPurify.sanitize(marked.parse(source, { gfm: true }), PURIFY);

            // Images: a relative src goes to a file of the artifact. Other sources stay (the CSP allows only this server).
            for (const img of body.querySelectorAll('img[src]')) {
                const src = img.getAttribute('src');
                if (EXTERNAL.test(src) || /^data:/i.test(src)) continue;
                const p = viewer.resolve(file.path, split(src).path);
                if (p !== null && viewer.file(p)) img.src = ctx.url(p);
                else img.removeAttribute('src');
            }

            // Links: a heading anchor jumps, a file of the artifact opens in the viewer, an outside link opens a new tab
            for (const a of body.querySelectorAll('a[href]')) {
                const href = a.getAttribute('href');
                if (EXTERNAL.test(href)) {
                    a.target = '_blank';
                    a.rel = 'noopener noreferrer';
                    continue;
                }
                const { path: rel, anchor } = split(href);
                const p = rel ? viewer.resolve(file.path, rel) : file.path;
                if (p !== null && viewer.file(p)) {
                    a.href = '#file=' + encodeURIComponent(p) + (anchor ? '&at=' + encodeURIComponent(anchor) : '');
                    a.addEventListener('click', (e) => {
                        e.preventDefault();
                        if (p === file.path) jump(body, anchor);
                        else viewer.open(p, anchor);
                    });
                } else {
                    a.removeAttribute('href');
                }
            }

            // The outline: the headings h1 to h3
            const used = new Set();
            const outline = viewer.el('nav', { class: 'md-outline', 'aria-label': 'Contents' });
            for (const h of body.querySelectorAll('h1, h2, h3, h4, h5, h6')) {
                h.id = slug(h.textContent, used);
                if (!/^H[1-3]$/.test(h.tagName)) continue;
                const link = viewer.el('a', { href: '#', text: h.textContent });
                link.style.paddingLeft = (Number(h.tagName[1]) - 1) * 12 + 4 + 'px';
                link.addEventListener('click', (e) => {
                    e.preventDefault();
                    outline.classList.remove('open');
                    h.scrollIntoView();
                });
                outline.append(link);
            }

            const layout = viewer.el('div', { class: 'md-layout' });
            if (outline.children.length > 1) {
                const toggle = viewer.el('button', { class: 'button md-toggle', type: 'button', 'aria-expanded': 'false', text: 'Contents' });
                toggle.addEventListener('click', () => {
                    toggle.setAttribute('aria-expanded', String(outline.classList.toggle('open')));
                });
                box.replaceChildren(toggle, layout);
                layout.append(outline);
            } else {
                box.replaceChildren(layout);
            }
            layout.append(body);
            jump(body, ctx.anchor);
        }
    });
})();
