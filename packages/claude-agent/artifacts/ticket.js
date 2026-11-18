/**
 * Copyright 2026 UpDownMe733
 * Licensed under the Apache License, Version 2.0
 * http://www.apache.org/licenses/LICENSE-2.0
 */

'use strict';

// The view ticket: it opens one version of one artifact on the view server for a short time.
// ticket = base64url(id|n|expiry) + "." + base64url(HMAC-SHA256(key, id|n|expiry))

const crypto = require('crypto');

const TTL_MS = 12 * 3600 * 1000;

const sign = (key, payload) => crypto.createHmac('sha256', key).update(payload).digest('base64url');

function make(key, id, n, ttlMs = TTL_MS, now = Date.now()) {
    const payload = `${id}|${n}|${now + ttlMs}`;
    return Buffer.from(payload).toString('base64url') + '.' + sign(key, payload);
}

// Give { id, n } for a valid ticket, else null.
function verify(key, ticket, now = Date.now()) {
    if (typeof ticket !== 'string') return null;
    const [body, mac, ...rest] = ticket.split('.');
    if (!body || !mac || rest.length) return null;
    const payload = Buffer.from(body, 'base64url').toString();
    const expected = Buffer.from(sign(key, payload));
    const given = Buffer.from(mac);
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
    const [id, n, expiry] = payload.split('|');
    if (!/^[0-9a-f]{16}$/.test(id) || !/^[0-9]+$/.test(n) || !(Number(expiry) > now)) return null;
    return { id, n: Number(n) };
}

module.exports = { make, verify };
