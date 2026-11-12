'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const { Worker } = require('worker_threads');

// Runs the code in the runner and gives the data of its first 'result' publish
function runCode(code, externalModules) {
    return new Promise((resolve, reject) => {
        const worker = new Worker(path.join(__dirname, 'fixtures', 'runner-harness.js'), {
            workerData: { code, node: { id: 'test' }, libs: [], userDir: os.tmpdir(), externalModules }
        });
        worker.on('message', ({ type, data }) => {
            if (type === 'result') resolve(data);
            else if (type === 'error') reject(new Error(data));
            worker.terminate();
        });
        worker.on('error', reject);
    });
}

const CODE = `const result = [];
    for (const name of ['fs', 'node:path', 'no-such-module', './no-such-file']) {
        try { result.push(typeof require(name)); } catch (err) { result.push(err.message); }
    }
    worker.parentPorts.publish('result', result);`;

describe('require in the worker runner', () => {
    it('loads Node.js built-ins only when functionExternalModules is false', async () => {
        assert.deepEqual(await runCode(CODE, false), [
            'object', 'object',
            "require('no-such-module'): the functionExternalModules setting is false, so only Node.js built-in modules load",
            "require('./no-such-file'): the functionExternalModules setting is false, so only Node.js built-in modules load"]);
    });

    it('loads other modules when functionExternalModules is not false', async () => {
        const result = await runCode(CODE, true);
        assert.deepEqual(result.slice(0, 2), ['object', 'object']);
        assert.match(result[2], /Cannot find module 'no-such-module'/);
    });
});
