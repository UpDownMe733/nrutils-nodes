// Images and SVG: fit to the width, or 100 %. An SVG in <img> runs no script. Pinch zoom works on the page.
'use strict';

viewer.register({
    name: 'image',
    match: (file) => /^image\/(png|jpeg|gif|webp|avif|bmp|x-icon|vnd\.microsoft\.icon|svg\+xml)$/.test(file.type),
    render: (box, file, ctx) => new Promise((resolve, reject) => {
        const img = viewer.el('img', { src: ctx.url(file.path), alt: file.path.split('/').pop() });
        const frame = viewer.el('div', { class: 'image' }, img);
        const zoom = viewer.el('button', { class: 'button', type: 'button', 'aria-pressed': 'false', text: '100 %' });
        zoom.addEventListener('click', () => {
            const full = frame.classList.toggle('full');
            zoom.setAttribute('aria-pressed', String(full));
        });
        img.addEventListener('load', resolve);
        img.addEventListener('error', () => reject(new Error('the image cannot load')));
        box.replaceChildren(viewer.el('div', { class: 'tools' }, zoom), frame);
    })
});
