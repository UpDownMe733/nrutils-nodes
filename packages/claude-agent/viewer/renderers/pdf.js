// PDF: the PDF viewer of the browser in an <iframe>. Chrome does not show a PDF in a sandboxed document,
// so this frame has no sandbox attribute. The view server serves a file as PDF only when its first bytes
// are "%PDF-"; else the file comes as application/octet-stream with the sandbox CSP.
'use strict';

viewer.register({
    name: 'pdf',
    match: (file) => file.type === 'application/pdf',
    render: async (box, file, ctx) => {
        box.replaceChildren(viewer.el('iframe', { class: 'frame', src: ctx.url(file.path), title: file.path }));
    }
});
