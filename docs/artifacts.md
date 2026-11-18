# Artifacts of the claude-agent node (design)

Status: design. Nothing in this document is built yet.

An artifact is an output that an agent makes and gives to people: a document, code, an image, a PDF, a table, a diagram, an HTML page or application, or a file of any type.
The operator reviews artifacts, shares them with people outside, and keeps them for a long time.

## 1. The parts

```
agent ──publish tool──► store (files in the user directory)
                            │
editor (admin origin) ──admin API──► list, versions, view ticket, share, delete
   │
   └─ iframe ──► view server (artifact origin, second port) ──► viewer page + files
                                                                   └─ iframe: HTML of the agent (opaque origin)
outside person ──► share server (third port, behind a public host) ──► the same viewer page, read only
```

- The **publish tool** copies the files of the agent into the store.
- The **store** keeps each version for ever, until a person deletes it.
- The **viewer page** is one web page that shows one version of one artifact. The editor and the share link use the same page. Thus each type has one renderer only.
- The **view server** and the **share server** are HTTP listeners in the Node-RED process, on ports that are not the editor port. They only read the store. They have no route that changes data.
- The **admin API** is a set of `RED.httpAdmin` routes. Only it changes data (share, delete). It needs the Node-RED permissions.

## 2. The publish tool

The node adds the tool `publish` to the MCP server `operator`, next to `send`, `handoff` and `ask_operator` (`claude-agent.js`, near `sdk.tool(`). Each run gets it.

```
publish({ path, name?, title?, entry?, note? })
```

| Field | Meaning | Default |
| --- | --- | --- |
| `path` | A file or a folder. Relative to the folder of the run, or absolute. It must be in `workRoot`. | necessary |
| `name` | The key of the artifact. The same name from the same agent makes a new version. Rule: `^[a-z0-9][a-z0-9._-]{0,63}$`. | the file or folder name, cleaned |
| `title` | The title that people see. | the first heading of a markdown or HTML entry, else the file name |
| `entry` | For a folder: the file that the viewer opens first. | `index.html`, else `README.md`, else the first file |
| `note` | What is new in this version. | empty |

- The result to the agent: `Published "<title>" as <name>, version <n>.` An error result has the reason, for example `the file is larger than 100 MB`.
- A publish of content that is the same as the last version makes no new version. The result says so.
- The tool reads the files when the agent calls it. A later change of the file does not change the stored version.
- Limits for each publish (settings, see section 9): 100 MB, 2000 files. A symbolic link, a device or a socket stops the publish with an error. The tool does not follow links.
- A run in a sandbox: the node cannot read the files of the sandbox. The setting `claudeAgent.sandboxExec` names a program with the arguments `<sandbox> <folder> <command...>` (the same form as the launcher). The node runs `tar -cf - -- <name>` through it and reads the tar stream with its own small reader: regular files and folders only, no absolute path, no `..`. A local run uses the same reader on a local `tar`, so there is one code path. With no `sandboxExec`, a sandbox run gets the error `this node cannot read files of a sandbox`.
- Each publish emits a new event kind `artifact`: `{ id, name, version, title, type, size }`. The popup chat, the Timeline, the third output and `agent-watch` get it, the same as other events.

## 3. The store

Place: `<userDir>/claude-agent/artifacts/` (setting `claudeAgent.artifacts.dir`). Plain files: a backup is a copy of the folder. No database.

```
artifacts/
  key                      the secret of the view tickets (mode 600, made at the first start)
  blobs/ab/cdef…           the content of each file, by its SHA-256. One copy of equal content.
  records/<id>.json        one record for each artifact
  shares.json              the share links
```

The id of an artifact: the SHA-256 of `<address of the agent>/<name>`, first 16 hex characters. The address is `team/name` of the node; a node with no name uses its node id.

A record:

```json
{
  "id": "3f9c0e1a7b2d4c55", "name": "report", "owner": { "address": "team/agent", "nodeId": "a1b2c3" },
  "versions": [
    { "n": 1, "time": 1763480000000, "title": "Load test report", "note": "", "entry": "report.md",
      "files": [{ "path": "report.md", "sha256": "…", "size": 4210, "type": "text/markdown" }],
      "run": { "runId": "…", "sessionId": "…" }, "deleted": false }
  ]
}
```

- Versions are append only. The number `n` goes up by one. A deleted version keeps its number, with `deleted: true` and no files.
- The node writes a record to a temporary file, then renames it. Thus a crash leaves the old record or the new record, never half.
- At start, the node reads all records into memory. 10 000 artifacts are some MB of memory.
- Retention: the store keeps all versions for ever. Only a person deletes: one version, or the artifact with all versions. The node never deletes on its own: the purpose is long term keeping.
- Delete has an undo. A delete sets `deleted: <time>` on the version or the record, and stops its share links. The editor can undo it for 30 days. After 30 days, the node removes the files of the deleted version and each blob that no record uses. The version number stays in the record with no files.
- The type of a file comes from its extension (a fixed table). Unknown extensions get `application/octet-stream`. The viewer tests such a file for text (valid UTF-8, no NUL byte in the first 8 KB).

## 4. The admin API

Routes on `RED.httpAdmin`, below `/claude-agent/artifacts`. Read routes need `claude-agent.read`, the others `claude-agent.write`.

| Route | Does |
| --- | --- |
| `GET /` with `?owner=&type=&since=&q=` | The list, newest first: id, name, title, owner, last version, time, type, size, number of active share links. `q` searches the titles and names. |
| `GET /:id` | The record |
| `POST /:id/:n/ticket` | A view URL on the view server for this version (section 6) |
| `GET /:id/:n/download` | The file, or a zip of the folder |
| `POST /:id/shares`, `DELETE /shares/:share` | Make and revoke a share link (section 7) |
| `GET /:id/shares` | The share links of the artifact |
| `DELETE /:id` and `DELETE /:id/:n` | Delete the artifact or one version (to the bin for 30 days) |
| `POST /:id/restore` and `POST /:id/:n/restore` | Undo a delete |

The runtime publishes `artifacts` on the comms of the node after each publish. The open lists then update with no poll.

## 5. The viewer page

One page, `viewer/index.html` of the package, with its scripts. The view server and the share server serve it. It gets the version from its URL, reads the file list from `meta`, and shows the entry file. A folder artifact also shows the list of its files.

### The renderers

A renderer is one script in `viewer/renderers/`. It registers an object:

```js
viewer.register({
    name: 'markdown',
    match: (file) => file.type === 'text/markdown',   // the first renderer that matches is used
    render: async (box, file, ctx) => { /* ctx.url(path), ctx.text(path), ctx.theme */ }
});
```

To add a type: add one renderer script, add it to the list in `viewer/index.html`, add a test. Nothing else changes.

| Type | Renderer | Size |
| --- | --- | --- |
| Text and code (by extension, or a text test) | `<pre>` with line numbers and wrap on or off | S |
| Markdown | `marked` (new dependency, the same library as the Node-RED editor). Relative images and links go to the files of the same artifact. An outline of the headings jumps to each part. | S |
| Image (png, jpeg, gif, webp, avif, bmp, ico) and SVG | `<img>`: fit to the width, zoom to 100 %, pinch zoom on touch. An SVG in `<img>` runs no script. | S |
| PDF | The PDF viewer of the browser, in an `<iframe>` | S |
| Audio and video | `<audio>`, `<video>` | S |
| HTML page or application | A nested `<iframe>` of the file. Its response has the `sandbox` CSP (section 6). | S |
| CSV and TSV | A table that scrolls in its own box, with a fixed header row, a fixed first column and a sort for each column | S |
| JSON | A tree that opens and closes | S |
| Other | The name, the type, the size, and Download | S |
| Later: syntax colours for code | `highlight.js` (new dependency) | S |
| Later: Mermaid diagrams (`.mmd`, and code blocks in markdown) | `mermaid` (new dependency, about 3 MB) | M |

Compare two versions:
- Text types: a line diff (own code, an LCS diff, about 100 lines), side by side on a wide screen, stacked in one column on a narrow screen.
- Images: the two images side by side.
- Other types: the size and the SHA-256 of each version.

The viewer page has no state. The theme (light or dark) comes in the URL.

## 6. Isolation

The editor runs with the admin rights of Node-RED. Content of an agent must never run with these rights. Three layers protect it:

1. **Another origin.** The view server listens on its own port. A port is a part of the origin, so the viewer page cannot read the DOM, the storage or the token of the editor. The editor shows the viewer page in an `<iframe>` of that origin.
2. **An opaque origin for each file.** Each file response has the header `Content-Security-Policy: sandbox allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads`, with no `allow-same-origin` and no `allow-top-navigation`. The browser then gives the file a unique origin. HTML of the agent cannot read the viewer page, other artifacts, cookies or storage, also when a person opens the file URL in a tab of its own. Exception: a PDF response has no `sandbox` CSP, because Chrome does not show a PDF in a sandboxed document. A PDF only gets the PDF viewer of the browser.
3. **Strict headers.** Each response has `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer` and `Cache-Control: private, no-store`. The viewer page has `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; frame-ancestors <editor origin> 'self'`. Thus HTML in a markdown file does not run.

Network of HTML artifacts: an HTML application can load files from `https:` (for example a chart library from a CDN). The agent wrote the page, and the agent can already send data anywhere from its shell, so this adds no new path out. The opaque origin holds no secret.

View tickets: the editor asks the admin API for a view URL. The URL is `/v/<ticket>/…` with `ticket = base64url(id, n, expiry) + "." + HMAC-SHA256(key, id|n|expiry)`. It is valid for one version for 12 hours. The ticket is in the path, so relative links inside a folder artifact work. A script of the artifact can read its own ticket: that ticket opens only the same version. The key is in the store file `key`, never in `settings.js`: the editor gets the full `claudeAgent` settings block.

## 7. Sharing outside

Two ways:

- **Download**: one file as it is, a folder as a zip (own zip writer, deflate of `zlib`, about 80 lines). This needs no host.
- **Share link**: `<publicUrl>/s/<share id>/`. The share id is 128 random bits. A record in `shares.json`: `{ id, artifact, version: n | "latest", created, expires, revoked, label }`.
  - The person in the editor chooses: this version or always the latest version, and the time: 1 day, 7 days (default), 30 days, or no end.
  - The share server serves only `/s/…` and the viewer page. It has no `/v/` route and no list. A share page shows the title, the version, the date and the content. It shows no owner, no run, no folder and no other artifact.
  - Revoke: the link stops at once. An expired or revoked link gives 404 with no detail.
  - The share server listens on its own port. A public host (a reverse proxy or a tunnel) sends that whole port to the internet. The view server and the editor stay on the LAN.
  - With no `publicUrl` set, the editor shows no share link action, only Download.
  - Preview: before a person copies a new link, the editor shows the share page itself, so the person sees what the outside person sees.
  - Copy link uses the clipboard. The share sheet of a phone (`navigator.share`) works only when the editor is on HTTPS; on HTTP only Copy link shows.
  - A download has `Content-Disposition: attachment` with the file name and the correct type.

## 8. The editor

<!-- From the popup UX designer, after the user needs. Section 10 has the needs. -->

## 9. Settings

`settings.js`, in the block `claudeAgent`:

```js
artifacts: {
    dir: '',                // default <userDir>/claude-agent/artifacts
    viewPort: 1881,         // the view server. 0 or no artifacts block: no viewer, publish still stores.
    viewUrl: '',            // the URL that the browser of the editor uses for the view server. Default: the host of the editor with viewPort.
    sharePort: 0,           // the share server. 0: no share links.
    publicUrl: '',          // the public URL of the share server
    maxBytes: 104857600,    // 100 MB for each publish
    maxFiles: 2000
},
sandboxExec: ''             // the program that runs a command in a sandbox
```

## 10. User needs

Three users gave their needs: an operator who watches many agents, a new user, and a user on a small screen with touch. The design follows them as below.

| Need | Users | Where in the design |
| --- | --- | --- |
| A new artifact never opens a popup, takes the focus or covers the canvas. A small sign on the node and one line in the chat or panel are enough. | all | section 8 |
| The chat shows the publish at its time: title, type in words or icon with word, version, time, agent. | new | event `artifact`, section 8 |
| One list for all agents, newest first, filters for agent, type and time, search by title. Find an old thing in 10 seconds. | watcher | admin API `GET /` with `owner`, `type`, `since`, `q` |
| One stable title for all versions; a clear "latest". | watcher, small screen | the name is the key; the title of the newest version shows |
| Read with one click, fast, inline. A big file or an HTML page must not make the editor slow. | all | the viewer runs in its own frame and process of the other origin; the list loads no content, only an image thumbnail |
| Compare a version with the one before. On a small screen: stacked, not side by side. | all | section 5, compare |
| A wide table scrolls in its own frame with the first column fixed. A long document has an outline. A big image fits and pinch zoom works. | small screen | the renderers of section 5 |
| An HTML application opens full screen in its own page, with a way back. | small screen | the viewer URL opens in a browser tab of its own |
| No version is overwritten. Nothing is lost after a restart or an update. | all | append-only versions, plain files in the user directory |
| Delete asks first, says which share links stop, and has an undo. | all | section 3, delete goes to a bin for 30 days |
| A share link is never made on its own. It says in words who can open it ("anyone with the link"), fixed version or latest, and the end date. It can be stopped at once. | all | section 7 |
| A preview of what the outside person sees, before the link goes out. | watcher | the editor opens the share page itself |
| The outside person sees only the content, the title, the version and the date: no agent names, prompts, paths or other things. No login. A readable page on a phone. | all | section 7 |
| HTML of an agent never reaches Node-RED or the cookies. | all | section 6 |
| Copy link, and the share sheet of the phone. Downloads have the right file name and type. | small screen | section 7, `Content-Disposition` with the file name |
| All actions work with one finger, 44 px targets, a visible text label, no hover, no right click. | small screen | section 8 |
| Plain words: not "artifact", "publish", "slug", "revision" or a hash. Use words such as "file", "new version", "shared link". "Shared" shows in words. | new | section 8 |
| A comment on a thing goes back to the agent as a task. | watcher (nice to have) | later part 10 |

## 11. The build order

| # | Part | Size | Needs |
| --- | --- | --- | --- |
| 1 | Store, publish tool for local files, event `artifact`, admin API list and record | M | — |
| 2 | View server with tickets and headers, viewer page with the renderers text, markdown, image, PDF, audio, video, HTML, other | L | a second port that the browser reaches |
| 3 | Editor: the card in the chat, the artifacts of a node, the list of all artifacts, open the viewer | M | section 8 |
| 4 | Download (file and zip), delete with blob clean up | S | — |
| 5 | Compare two versions | M | — |
| 6 | Share server and share links | M | a public host for the share port |
| 7 | Sandbox read (`sandboxExec`, tar reader) | M | a program that the Node-RED user may run |
| 8 | CSV, TSV and JSON renderers | S | — |
| 9 | Later: syntax colours, Mermaid | S + M | new dependencies |
| 10 | Later: a comment on a version goes to the inbox of its agent as a message | S | the MQTT inbox of the node |

Sizes: S is less than 150 lines with tests, M 150 to 400, L more than 400.

## 12. Open risks

- An agent can publish HTML that tries to trick a person, for example a fake login form. The opaque origin stops access to data, not a lie on the screen. The viewer shows the owner and the type above each HTML artifact.
- Chrome shows a PDF only outside a sandbox, so a PDF depends on the PDF viewer of the browser for its safety.
- The store grows with no limit, because nothing deletes on its own. The list shows the size of each artifact and the total.
