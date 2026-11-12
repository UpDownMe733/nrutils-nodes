# nrutils-nodes

Node-RED nodes built on [@nrutils/node-red-utils](https://www.npmjs.com/package/@nrutils/node-red-utils). Each node is a separate npm package. Install only the nodes that you need.

## Nodes

| Node | Package | What it does |
| --- | --- | --- |
| [worker function](packages/worker-function) | [`@nrutils/node-red-worker-function`](https://www.npmjs.com/package/@nrutils/node-red-worker-function) | A Function node that runs its code in a worker thread |

## Install

Use **Manage palette** in the Node-RED editor and search for the package name. Or, in your Node-RED user directory (usually `~/.node-red`):

```
npm install @nrutils/node-red-worker-function
```

Each node has its own README with the full documentation. Click the node name in the table.

## Problems

- If npm stops with an `ERESOLVE` error for `@nrutils/node-red-utils`, update all your `@nrutils` nodes to their newest versions.
- For a bug or a question, open an issue in this repo. Put the node name in the title.

To work on the code, see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Apache-2.0
