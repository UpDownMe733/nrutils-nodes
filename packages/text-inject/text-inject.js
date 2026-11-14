/**
 * Copyright 2026 UpDownMe733
 * Licensed under the Apache License, Version 2.0
 * http://www.apache.org/licenses/LICENSE-2.0
 */

'use strict';

// The text-inject node. The popup in the editor sends its text here.
// The node sends it on as msg.payload, the same as an inject node.

const { NodeRedNodeBase, nodeRedPopup, nodeRedEditorComms } = require('@nrutils/node-red-utils');

module.exports = NodeRedNodeBase.createNode('text-inject', [nodeRedPopup, nodeRedEditorComms], (RED, thisNode, config) => {
    thisNode.nodeRedEditorComms.subscribe('send', (text) => {
        if (typeof text !== 'string') throw new Error('text must be a string');
        thisNode.send({ payload: text });
        thisNode.status({ text: `sent ${text.length} chars` });
        return text.length;
    });
});
