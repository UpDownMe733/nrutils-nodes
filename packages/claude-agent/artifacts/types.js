/**
 * Copyright 2026 UpDownMe733
 * Licensed under the Apache License, Version 2.0
 * http://www.apache.org/licenses/LICENSE-2.0
 */

'use strict';

// The type of a file comes from its extension. An unknown extension gives application/octet-stream.
const TYPES = {
    md: 'text/markdown', markdown: 'text/markdown', txt: 'text/plain', log: 'text/plain',
    html: 'text/html', htm: 'text/html', css: 'text/css', csv: 'text/csv', tsv: 'text/tab-separated-values',
    js: 'text/javascript', mjs: 'text/javascript', json: 'application/json', xml: 'application/xml',
    svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp', ico: 'image/x-icon',
    pdf: 'application/pdf', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4',
    mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', zip: 'application/zip'
};

function typeOf(file) {
    const m = /\.([A-Za-z0-9]+)$/.exec(file);
    return (m && TYPES[m[1].toLowerCase()]) || 'application/octet-stream';
}

module.exports = { typeOf };
