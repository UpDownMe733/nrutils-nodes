'use strict';

// Runs worker-runner.js in a worker thread with a fake worker object.
// A publish goes to the test as a message { type, data }.
const { workerData, parentPort } = require('worker_threads');
const run = require('../../worker-runner.js');

const ports = { subscribe() {}, publish: (type, data) => parentPort.postMessage({ type, data }) };
run({ parentPorts: ports, inputPorts: ports, outputPorts: ports }, workerData);
