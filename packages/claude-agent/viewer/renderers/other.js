// Other types: the name, the type, the size, and Download. It matches each file, so it is the last renderer.
'use strict';

viewer.register({
    name: 'other',
    match: () => true,
    render: async (box, file, ctx) => {
        const name = file.path.split('/').pop();
        box.replaceChildren(viewer.el('div', { class: 'other' },
            viewer.el('div', { class: 'name', text: name }),
            viewer.el('div', { class: 'secondary', text: file.type + ' · ' + viewer.size(file.size) }),
            viewer.el('div', { text: 'This file cannot show here.' }),
            viewer.el('a', { class: 'button', href: ctx.url(file.path), download: name, text: 'Download' })));
    }
});
