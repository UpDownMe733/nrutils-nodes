// Audio and video: the <audio> and <video> elements of the browser
'use strict';

viewer.register({
    name: 'media',
    match: (file) => /^(audio|video)\//.test(file.type),
    render: async (box, file, ctx) => {
        const tag = file.type.startsWith('video/') ? 'video' : 'audio';
        const media = viewer.el(tag, { src: ctx.url(file.path), controls: true, preload: 'metadata' });
        media.addEventListener('error', () => viewer.fallback(box, file));
        box.replaceChildren(viewer.el('div', { class: 'media' }, media));
    }
});
