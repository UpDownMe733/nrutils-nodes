// An HTML page or application: a nested <iframe> of the file. The response of the file has the sandbox CSP,
// so the page gets an opaque origin. The sandbox attribute here is a second layer with the same rights.
'use strict';

viewer.register({
    name: 'html',
    match: (file) => file.type === 'text/html' || file.type === 'application/xhtml+xml',
    render: async (box, file, ctx) => {
        box.replaceChildren(viewer.el('iframe', {
            class: 'frame', src: ctx.url(file.path), title: file.path,
            sandbox: 'allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads'
        }));
    }
});
