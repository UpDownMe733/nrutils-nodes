// JSON: a tree that opens and closes. The children of a node are made when it opens for the first time,
// in pages of 200 with a "Show more" button. A file that is not valid JSON or that is too large shows as text.
'use strict';

(function () {
    // A number that a JavaScript number cannot hold exactly (for example a 64-bit id) keeps its source text
    class Exact { constructor(text) { this.text = text; } }
    const PAGE = 200;

    function parse(text) {
        return JSON.parse(text, (key, value, ctx) =>
            typeof value === 'number' && ctx && ctx.source !== undefined && String(value) !== ctx.source ? new Exact(ctx.source) : value);
    }

    function leaf(value) {
        if (value instanceof Exact) return viewer.el('span', { class: 'j-num', text: value.text });
        if (value === null) return viewer.el('span', { class: 'j-null', text: 'null' });
        if (typeof value === 'string') return viewer.el('span', { class: 'j-str', text: JSON.stringify(value) });
        return viewer.el('span', { class: typeof value === 'number' ? 'j-num' : 'j-bool', text: String(value) });
    }

    function label(key) {
        return key === undefined ? [] : [viewer.el('span', { class: 'j-key', text: typeof key === 'number' ? String(key) : JSON.stringify(key) }), ': '];
    }

    // One node: a leaf, or a <details> element for an object or an array
    function node(key, value, open) {
        if (value === null || typeof value !== 'object' || value instanceof Exact) {
            return viewer.el('div', { class: 'j-leaf' }, ...label(key), leaf(value));
        }
        const array = Array.isArray(value);
        const keys = array ? value.map((v, i) => i) : Object.keys(value);
        const count = keys.length + (array ? (keys.length === 1 ? ' item' : ' items') : (keys.length === 1 ? ' key' : ' keys'));
        if (!keys.length) return viewer.el('div', { class: 'j-leaf' }, ...label(key), viewer.el('span', { class: 'secondary', text: array ? '[ ]' : '{ }' }));
        const details = viewer.el('details', { class: 'j-node' },
            viewer.el('summary', {}, ...label(key), viewer.el('span', { class: 'secondary', text: (array ? '[ ' : '{ ') + count + (array ? ' ]' : ' }') })));
        let made = 0;
        const more = viewer.el('button', { class: 'button j-more', type: 'button' });
        // Adds the next page of children, and the button for the rest
        const page = () => {
            const frag = document.createDocumentFragment();
            for (const k of keys.slice(made, made + PAGE)) frag.append(node(k, value[k], false));
            made = Math.min(made + PAGE, keys.length);
            more.remove();
            details.append(frag);
            const rest = keys.length - made;
            if (rest) {
                more.textContent = 'Show ' + Math.min(rest, PAGE) + ' more (' + rest + ' left)';
                details.append(more);
            }
        };
        more.addEventListener('click', page);
        const make = () => { if (!made) page(); };
        details.addEventListener('toggle', () => { if (details.open) make(); });
        if (open) { make(); details.open = true; }
        return details;
    }

    viewer.register({
        name: 'json',
        cuts: true,
        parse,
        match: (file) => file.type === 'application/json' || /^application\/[\w.-]+\+json$/.test(file.type),
        render: async (box, file, ctx) => {
            if (file.size > viewer.TEXT_LIMIT) return viewer.renderWith('text', box, file, ctx);
            const text = await ctx.text(file.path);
            let value;
            try { value = parse(text); } catch (e) { return viewer.renderWith('text', box, file, ctx); }
            box.replaceChildren(viewer.el('div', { class: 'json' }, node(undefined, value, true)));
        }
    });
})();
