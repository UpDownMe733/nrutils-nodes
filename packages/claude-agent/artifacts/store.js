/**
 * Copyright 2026 UpDownMe733
 * Licensed under the Apache License, Version 2.0
 * http://www.apache.org/licenses/LICENSE-2.0
 */

'use strict';

// The store of the artifacts: plain files in one folder. See docs/artifacts.md, section 3.
//   key                  the secret of the view tickets
//   blobs/ab/cdef...     the content of each file, by its SHA-256
//   records/<id>.json    one record for each artifact

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { typeOf } = require('./types');

const BIN_MS = 30 * 24 * 3600 * 1000;
const NAME_RULE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const idOf = (nodeId, name) => sha256(`${nodeId}/${name}`).slice(0, 16);

// Write a file with a temporary file and a rename: a crash leaves the old file or the new file.
function writeAtomic(file, data, mode) {
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, data, { mode });
    fs.renameSync(tmp, file);
}

// The default name of an artifact: the file or folder name, cleaned to the rule.
function cleanName(file) {
    const name = path.posix.basename(file).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[^a-z0-9]+/, '').slice(0, 64);
    return name || 'file';
}

// Remove each <...> part and join the white space. One pass: it cannot run for a long time.
function stripTags(text) {
    let out = '';
    let depth = false;
    for (const c of text) {
        if (c === '<') depth = true;
        else if (c === '>' && depth) depth = false;
        else if (!depth) out += c;
    }
    return out.replace(/\s+/g, ' ').trim();
}

// The first heading of a markdown or HTML file, else ''. The code uses string search and one pass: no pattern can run for a long time.
function headingOf(file, data) {
    const text = data.subarray(0, 64 * 1024).toString('utf8');
    const type = typeOf(file);
    if (type === 'text/markdown') {
        const m = /^#{1,6}[ \t]+(.+)$/m.exec(text);
        if (!m) return '';
        let end = m[1].length;
        while (end > 0 && ' \t#'.includes(m[1][end - 1])) end--;
        return m[1].slice(0, end).trim();
    }
    if (type === 'text/html') {
        const lower = text.toLowerCase();
        for (const tag of ['title', 'h1']) {
            const open = lower.indexOf('<' + tag);
            const start = open < 0 ? -1 : lower.indexOf('>', open);
            const end = start < 0 ? -1 : lower.indexOf('</' + tag, start);
            if (end >= 0) return stripTags(text.slice(start + 1, end));
        }
    }
    return '';
}

function pickEntry(files, entry) {
    if (entry) {
        const clean = entry.replace(/^\.\//, '');
        if (!files.some((f) => f.path === clean)) throw new Error(`the entry "${entry}" is not in the files`);
        return clean;
    }
    for (const name of ['index.html', 'README.md']) if (files.some((f) => f.path === name)) return name;
    return files[0].path;
}

function createStore(dir) {
    // Only the Node-RED user can read the store: the agent users must not read the artifacts of other agents.
    for (const sub of ['', 'blobs', 'records']) fs.mkdirSync(path.join(dir, sub), { recursive: true, mode: 0o700 });
    const keyFile = path.join(dir, 'key');
    if (!fs.existsSync(keyFile)) writeAtomic(keyFile, crypto.randomBytes(32), 0o600);
    const key = fs.readFileSync(keyFile);
    const records = new Map();
    for (const name of fs.readdirSync(path.join(dir, 'records'))) {
        if (!name.endsWith('.json')) continue;
        const record = JSON.parse(fs.readFileSync(path.join(dir, 'records', name), 'utf8'));
        records.set(record.id, record);
    }

    const blobPath = (sha) => path.join(dir, 'blobs', sha.slice(0, 2), sha.slice(2));
    const save = (record) => writeAtomic(path.join(dir, 'records', record.id + '.json'), JSON.stringify(record, null, 1));

    async function writeBlob(sha, data) {
        const file = blobPath(sha);
        if (fs.existsSync(file)) return;
        await fs.promises.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
        const tmp = `${file}.${crypto.randomBytes(4).toString('hex')}.tmp`;
        await fs.promises.writeFile(tmp, data, { mode: 0o600 });
        await fs.promises.rename(tmp, file);
    }

    // A version that people can open: not deleted and not purged.
    const active = (v) => !v.deleted && !v.purged;

    // Make a new version of the artifact. input: { nodeId, address, name, title, entry, note, run, files: [{ path, data }] }.
    // Gives { record, version, unchanged }. unchanged: the content is the same as the last version, so no new version.
    async function publish(input) {
        if (!input.files.length) throw new Error('there is no file to publish');
        const name = input.name || cleanName(input.defaultName);
        if (!NAME_RULE.test(name)) throw new Error(`the name "${name}" must match ${NAME_RULE}`);
        const files = input.files.map((f) => ({ path: f.path, data: f.data, sha256: sha256(f.data) })).sort((a, b) => (a.path < b.path ? -1 : 1));
        const entry = pickEntry(files, input.entry);
        const entryFile = files.find((f) => f.path === entry);
        const title = String(input.title || headingOf(entry, entryFile.data) || path.posix.basename(entry)).slice(0, 200);
        for (const f of files) await writeBlob(f.sha256, f.data);
        // From here on the code does not wait: two publishes of one artifact get two version numbers.
        const id = idOf(input.nodeId, name);
        let record = records.get(id);
        const list = files.map((f) => ({ path: f.path, sha256: f.sha256, size: f.data.length, type: typeOf(f.path) }));
        const last = record && record.versions[record.versions.length - 1];
        const open = record && !record.deleted && [...record.versions].reverse().find(active);
        if (open && open.entry === entry && open.title === title && JSON.stringify(open.files) === JSON.stringify(list)) {
            return { record, version: open, unchanged: true };
        }
        if (!record) record = { id, name, owner: {}, deleted: null, versions: [] };
        record.owner = { address: input.address, nodeId: input.nodeId };
        const version = { n: last ? last.n + 1 : 1, time: Date.now(), title, note: input.note || '', entry, files: list, run: input.run || null, deleted: null, purged: false };
        record.versions.push(version);
        records.set(id, record);
        save(record);
        return { record, version, unchanged: false };
    }

    // The newest version that people can open, or undefined.
    function newest(record) {
        if (record.deleted) return undefined;
        return [...record.versions].reverse().find(active);
    }

    // The list for the editor, newest first. filter: { owner, type, since, q }.
    function list(filter = {}) {
        const items = [];
        const q = String(filter.q || '').toLowerCase();
        for (const record of records.values()) {
            const v = newest(record);
            if (!v) continue;
            const type = (v.files.find((f) => f.path === v.entry) || {}).type || '';
            const item = {
                id: record.id, name: record.name, title: v.title, owner: record.owner.address, nodeId: record.owner.nodeId,
                version: v.n, versions: record.versions.filter(active).length, time: v.time, type, size: v.files.reduce((s, f) => s + f.size, 0), shares: 0
            };
            if (filter.owner && filter.owner !== item.owner && filter.owner !== item.nodeId) continue;
            if (filter.type && !type.startsWith(filter.type)) continue;
            if (filter.since && v.time < Number(filter.since)) continue;
            if (q && !item.title.toLowerCase().includes(q) && !item.name.includes(q)) continue;
            items.push(item);
        }
        return items.sort((a, b) => b.time - a.time);
    }

    const get = (id) => records.get(id);

    // One version that people can open, or undefined.
    function version(id, n) {
        const record = records.get(id);
        const v = record && !record.deleted && record.versions.find((x) => x.n === Number(n));
        return v && active(v) ? v : undefined;
    }

    // The file entry of a version by the exact path, or undefined.
    function file(id, n, filePath) {
        const v = version(id, n);
        return v && v.files.find((f) => f.path === filePath);
    }

    // Delete the artifact (no n) or one version into the bin. Gives the record, or undefined when there is nothing to delete.
    function remove(id, n, now = Date.now()) {
        const record = records.get(id);
        const target = record && (n === undefined ? record : record.versions.find((v) => v.n === Number(n)));
        if (!target || target.purged || target.deleted) return undefined;
        target.deleted = now;
        save(record);
        return record;
    }

    // Undo a delete that the purge has not removed. Gives the record, or undefined.
    function restore(id, n) {
        const record = records.get(id);
        const target = record && (n === undefined ? record : record.versions.find((v) => v.n === Number(n)));
        if (!target || target.purged || !target.deleted) return undefined;
        target.deleted = null;
        save(record);
        return record;
    }

    // Purge each version that is in the bin for 30 days: clear its file list, then remove each blob that no version uses.
    // Gives the records that changed.
    function purge(now = Date.now()) {
        const changed = [];
        for (const record of records.values()) {
            const gone = (record.deleted || 0) && now - record.deleted >= BIN_MS;
            let touched = false;
            for (const v of record.versions) {
                if (v.purged || !(gone || (v.deleted && now - v.deleted >= BIN_MS))) continue;
                v.purged = true;
                v.files = [];
                touched = true;
            }
            if (touched) {
                save(record);
                changed.push(record);
            }
        }
        if (!changed.length) return changed;
        const used = new Set();
        for (const record of records.values()) for (const v of record.versions) for (const f of v.files) used.add(f.sha256);
        for (const sha of blobs()) if (!used.has(sha)) fs.rmSync(blobPath(sha), { force: true });
        return changed;
    }

    // The sha of each blob in the store
    function blobs() {
        const out = [];
        for (const a of fs.readdirSync(path.join(dir, 'blobs'))) {
            for (const b of fs.readdirSync(path.join(dir, 'blobs', a))) if (!b.endsWith('.tmp')) out.push(a + b);
        }
        return out;
    }

    // The bytes of all blobs: the files of the bin count, because they stay for 30 days.
    const totalBytes = () => blobs().reduce((sum, sha) => sum + fs.statSync(blobPath(sha)).size, 0);

    return { key, publish, list, get, version, file, blobPath, idOf, dir, remove, restore, purge, totalBytes };
}

module.exports = { createStore, NAME_RULE };
