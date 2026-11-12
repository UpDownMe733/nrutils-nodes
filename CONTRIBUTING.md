# Contributing to nrutils-nodes

## Development

Start with:

```
git clone https://github.com/UpDownMe733/nrutils-nodes.git
cd nrutils-nodes
```

Requirements: the tests need Node.js 22 because they run Node-RED 5. The nodes themselves run on Node.js 18 or later.

```
npm install     # installs all packages and one copy of node-red-utils
npm test        # runs the tests of all packages, each in a real Node-RED
npm run demo    # Node-RED with the example flows on port 1890 (user dir: demo/)
```

Each folder in `packages/` is one npm package with its own name, version and tests. To test one package: `npm test -w packages/worker-function`.

## Rules for a node

Worker nodes connect thread to thread only inside one copy of node-red-utils. The peer dependency makes npm install one copy for all the nodes.

- Put `@nrutils/node-red-utils` in `peerDependencies`, never in `dependencies`.
- Use the same range in every package.
- To check that there is one copy, run `npm ls @nrutils/node-red-utils`. It must show one version, deduped.

## Add a node

1. Copy `packages/worker-function` to `packages/<node>` and rename the files. The files are:
   - `<node>.js` (runtime)
   - `<node>.html` (editor and help)
   - `icons/`
   - `examples/` (an example flow)
   - `test/`
   - `README.md`
   - `LICENSE`
   - `package.json`
2. Edit `package.json`:
   - the name `@nrutils/node-red-<node>`
   - the keyword `node-red`
   - the block `"node-red": { "version": ">=4.0.0", "nodes": { "<node>": "<node>.js" } }`. Without it, Node-RED loads nothing.
   - `@nrutils/node-red-utils` in `peerDependencies`
   - a `files` list that leaves out `test/`
   - `repository.directory`
3. Add the package to `demo/package.json`, and its example flow to `demo/flows.json`.
4. Add a row to the Nodes table.
5. Run `npm install` at the root (it updates `package-lock.json`) and `npm test`.

## Pull requests

- Open an issue first for a new node.
- A PR has tests for each behavior change. For a new node, it also has the README row and the demo entry.
- CI runs `npm test` on each PR.
