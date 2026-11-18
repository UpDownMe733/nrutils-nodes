// Text and code: a <pre> with line numbers, and wrap on or off.
// It matches text types by type, and a file of type application/octet-stream that passed the text test.
'use strict';

viewer.register({
    name: 'text',
    match: (file) => file.isText || /^text\//.test(file.type) ||
        /^application\/(json|xml|javascript|x-sh|x-yaml|yaml|toml|sql|x-httpd-php)$/.test(file.type) || /\+(json|xml)$/.test(file.type),
    render: async (box, file, ctx) => {
        const text = await ctx.text(file.path);
        const pre = viewer.el('pre', { class: 'text wrap' });
        const lines = text.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n');
        const frag = document.createDocumentFragment();
        for (const line of lines) frag.append(viewer.el('span', { text: line || '​' }));
        pre.append(frag);
        const wrap = viewer.el('button', { class: 'button', type: 'button', 'aria-pressed': 'true', text: 'Wrap' });
        wrap.addEventListener('click', () => {
            const on = pre.classList.toggle('wrap');
            wrap.setAttribute('aria-pressed', String(on));
        });
        box.replaceChildren(viewer.el('div', { class: 'tools' }, wrap), pre);
    }
});
