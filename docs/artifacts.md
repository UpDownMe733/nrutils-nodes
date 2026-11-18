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

The node adds the tool `publish` to the MCP server `operator`, next to `send`, `handoff` and `ask_operator` (`claude-agent.js`, near `sdk.tool(`). Each run gets it, in each session mode, also with no inbox. (`handoff` is only in agent mode, and `send` only with an inbox.)

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
- Limits for each publish (settings, see section 9): 100 MB, 2000 files.
- The node never reads the files of the agent with its own rights. The Node-RED user can read files that the agent cannot (`settings.js`, the credentials, the ticket key). A symbolic link in a parent folder, or a file swap between a check and the read, would give them to the agent.
  Thus the node reads all files with one code path: it runs `tar -cf - -- <name>` with the rights of the agent, and reads the tar stream with its own small reader.
  - The setting `claudeAgent.agentExec` names a program with the arguments `<sandbox or -> <folder> <command...>`. It runs the command as the agent user, in the sandbox when a sandbox is named, else on the host.
  - The node starts it with `spawn` and an argument array, never with a shell.
  - With no `claudeAgent.launcher`, the agent runs as the Node-RED user. Then the node runs `tar` directly, because the agent already has these rights.
  - With a launcher and no `agentExec`, publish gives the error `this node cannot read files with the rights of the agent`.
- The tar reader accepts regular files and folders only. It stops the publish with an error on these:
  - a symbolic link, a hard link, a device, a FIFO;
  - a name (also a pax or GNU long name) that is absolute, or that has a `..` part;
  - more bytes or more files than the limits. The reader counts on the stream, and kills `tar` at the limit.
- Each publish emits a new event kind `artifact`. `event()` copies only the extra fields that it knows, so it gets one more field: `artifact: { id, name, version, title, type, size }`. The popup chat, the Timeline, the third output and `agent-watch` get it, the same as other events.

## 3. The store

Place: `<userDir>/claude-agent/artifacts/` (setting `claudeAgent.artifacts.dir`). Plain files: a backup is a copy of the folder. No database.

```
artifacts/
  key                      the secret of the view tickets (mode 600, made at the first start)
  blobs/ab/cdef…           the content of each file, by its SHA-256. One copy of equal content.
  records/<id>.json        one record for each artifact
  shares.json              the share links
```

The id of an artifact: the SHA-256 of `<node id>/<name>`, first 16 hex characters. The node id does not change when a person renames the tab or the node, so the versions stay in one record. The record also keeps the address (`team/name`, from `NR_FLOW_NAME` and the node name) of the newest publish, for the display. A node with no name shows its node id. A copy or an import of a node gives a new node id, so its new versions go into a new record. This is accepted: the copy is a new agent.

A record:

```json
{
  "id": "3f9c0e1a7b2d4c55", "name": "report", "owner": { "address": "team/agent", "nodeId": "a1b2c3" },
  "versions": [
    { "n": 1, "time": 1763480000000, "title": "Load test report", "note": "", "entry": "report.md",
      "files": [{ "path": "report.md", "sha256": "…", "size": 4210, "type": "text/markdown" }],
      "run": { "runId": "…", "sessionId": "…" }, "deleted": null, "purged": false }
  ]
}
```

- Versions are append only. The number `n` goes up by one. A version is never removed from the record.
- The node writes a record to a temporary file, then renames it. Thus a crash leaves the old record or the new record, never half.
- At start, the node reads all records into memory. 10 000 artifacts are some MB of memory.
- Retention: the store keeps all versions for ever. Only a person deletes: one version, or the artifact with all versions. The node never deletes on its own: the purpose is long term keeping.
- Delete has an undo. A delete sets `deleted` to the time on the version or the record (else `deleted` is `null`). Its share links stop: the share server gives 404 for a link while its artifact or version is deleted, and does not change the link record. Thus an undo makes the links work again, except a link that a person revoked or that expired. A link to the newest version shows the newest version that is not deleted. It gives 404 only when all versions are deleted. The files stay, and the editor can undo it for 30 days. After 30 days, the node sets `purged: true`, clears the file list of the version, revokes the share links to that version, and a newest version link when no version is left (revoked links leave the lists of open links), and removes each blob that no record uses. The version number stays in the record.
- The type of a file comes from its extension (a fixed table). Unknown extensions get `application/octet-stream`. The viewer tests such a file for text (valid UTF-8, no NUL byte in the first 8 KB).

## 4. The admin API

Routes on `RED.httpAdmin`, below `/claude-agent/artifacts`. Read routes need `claude-agent.read`, the others `claude-agent.write`.

| Route | Does |
| --- | --- |
| `GET /` with `?owner=&type=&since=&q=` | The list, newest first: id, name, title, owner, last version, time, type, size, number of active share links (links that work now: not revoked, not expired, and not on a deleted artifact or version). `q` searches the titles and names. The response also has `totalBytes`: the bytes of all blob files on the disk (one copy of equal content, the bin included until the purge). It does not depend on the filters. |
| `GET /:id` | The record |
| `POST /:id/:n/ticket` | A view URL on the view server for this version (section 6). The download URL is in it. |
| `POST /:id/shares`, `PUT /shares/:share`, `DELETE /shares/:share` | Make, extend and revoke a share link (section 7) |
| `GET /shares` and `GET /:id/shares` | All open share links, and the share links of one artifact. They include a link that stopped because of a delete, marked `stopped: "deleted"`, because an undo brings it back. They do not include a revoked or expired link. |
| `DELETE /:id` and `DELETE /:id/:n` | Delete the artifact or one version (to the bin for 30 days) |
| `POST /:id/restore` and `POST /:id/:n/restore` | Undo a delete |

The admin API sends no byte of an artifact. The admin origin holds the token of the editor: an HTML file there, or a `blob:` URL that the editor makes from artifact bytes, would run with that token. Thus the content, the thumbnails and the downloads come only from the view server. The list gives a thumbnail URL with a ticket for each image.

After each publish, delete and undo, the runtime sends the topic `claude-agent/artifacts` with `RED.comms.publish`, with the new record and the new `totalBytes`. The comms of a node are for that node only, so the sidebar list of all agents needs this global topic. The open lists then update with no poll.

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
| Markdown | `marked` (new dependency, the same library as the Node-RED editor), then `DOMPurify` on its HTML (new dependency: HTML in markdown must not add a script, a frame or a form). Relative images and links go to the files of the same artifact. An outline of the headings jumps to each part. | S |
| Image (png, jpeg, gif, webp, avif, bmp, ico) and SVG | `<img>`: fit to the width, zoom to 100 %, pinch zoom on touch. An SVG in `<img>` runs no script. | S |
| PDF | The PDF viewer of the browser, in an `<iframe>`. Only for the type `application/pdf` with the first bytes `%PDF-` (section 6). Else the "other" renderer. | S |
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

The editor runs with the admin rights of Node-RED. Content of an agent must never run with these rights. These layers protect it:

1. **No artifact byte on the admin origin.** See section 4. The editor shows content only in an `<iframe>` of the view server, and links a download to the view server.
2. **Another origin.** The view server is its own `http.Server` on its own port, with no Express app of Node-RED. A port is a part of the origin, so the viewer page cannot read the DOM, the storage or the token of the editor.
3. **An opaque origin for each file.** Each file response has this header (one line):
   `Content-Security-Policy: sandbox allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads; default-src 'self' data: blob: 'unsafe-inline' 'unsafe-eval'`.
   It has no `allow-same-origin` and no `allow-top-navigation`. The browser gives the file a unique origin. HTML of the agent cannot read the viewer page, other artifacts, cookies or storage, also in a browser tab of its own.
4. **A strict viewer page.** The viewer page has a new random nonce for each response:
   `Content-Security-Policy: default-src 'self'; script-src 'nonce-<n>'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors <editor origin> 'self'`.
   `script-src 'self'` is not enough: it allows each artifact file on the same origin as a script, and a sandbox CSP has no effect on a script that another page loads. With the nonce, only the scripts of the viewer run, and `DOMPurify` removes HTML that tries to add more.
5. **Strict headers.** Each response has `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer` and `Cache-Control: private, no-store`.
6. **Exact paths.** The view server and the share server find a file only by an exact match of its path in the file list of the version. They never join a path from the URL to a folder.
7. **Messages.** The editor accepts a `postMessage` only when `event.origin` is the origin of the view server. It accepts only data (for example "loaded"), never a command.

The PDF exception: Chrome does not show a PDF in a sandboxed document, so a PDF response has no `sandbox` CSP. The view server serves a file as PDF only when its type is exactly `application/pdf` and its first bytes are `%PDF-`. The response has `nosniff`. Else the file is served as `application/octet-stream` with the sandbox CSP.

Download: `/v/<ticket>/download` gives the file, or a zip of the folder, with `Content-Disposition: attachment; filename=…`, `Content-Type: application/octet-stream`, `nosniff` and the sandbox CSP.

Network of HTML artifacts: the CSP of a file allows only the view server, `data:` and `blob:`. Thus a page that a person reviewed cannot change later through remote content, and it cannot track an outside reader.
- The view server on the LAN also allows `https:` (setting `artifacts.htmlNetwork`, default `true`). An HTML application can then load a library from a CDN in the editor. The agent can already send data anywhere from its shell, so this adds no new path out.
- The share server allows only the hosts in `artifacts.shareHosts` (default none). The preview of a share link (section 7) shows the share page, so the person sees a page that needs a host that is not on the list.

View tickets: the editor asks the admin API for a view URL. The URL is `/v/<ticket>/…` with `ticket = base64url(id, n, expiry) + "." + HMAC-SHA256(key, id|n|expiry)`. It is valid for one version for 12 hours. The ticket is in the path, so relative links inside a folder artifact work. A script of the artifact can read its own ticket: that ticket opens only the same version. The key is in the store file `key`, never in `settings.js`: the editor gets the full `claudeAgent` settings block.

## 7. Sharing outside

Two ways:

- **Download**: one file as it is, a folder as a zip (own zip writer, deflate of `zlib`, about 80 lines). This needs no host. The editor links to the download URL of the view server (section 6).
- **Share link**: `<publicUrl>/s/<share id>/`. The share id is 128 random bits. A record in `shares.json`: `{ id, artifact, version: n | "latest", created, expires, revoked, label }`.
  - A share link never shows more than its one artifact. Its record and its page have no owner, no run and no folder.
  - The version: the default is the version that the person sees. "Always the newest version" is an explicit choice with this warning: "Each new version that the agent makes goes to the people with the link, with no review." An agent can be under prompt injection, so a fixed version is the safe default.
  - The time: 1 day, 7 days (default) or 30 days. 30 days is the longest time. "Extend" sets a new end of 1, 7 or 30 days from now, and keeps the URL.
  - The UI says "newest", never "latest". `latest` is only the value in `shares.json`.
  - The editor has one list of all open share links of all artifacts, with the end date of each and a revoke action. A link of a deleted artifact or version shows "Stopped: file deleted" in this list and in the share panel. The chip "Shared" counts only links that work now.
  - The share server is its own `http.Server` on its own port, with no Express app of Node-RED. It serves only `/s/…`, the download of that share and the viewer page. It has no `/v/` route and no list. A share page shows the title, the version, the date and the content.
  - It binds to `127.0.0.1` by default (setting `artifacts.shareBind`), for a tunnel on the same host. A public host (a reverse proxy or a tunnel) sends that whole port to the internet. The view server and the editor stay on the LAN.
  - Revoke: the link stops at once. An expired or revoked link gives 404 with no detail.
  - With no `publicUrl` set, the editor shows no share link action, only Download.
  - Preview: before a person copies a new link, the editor shows the share page itself, so the person sees what the outside person sees.
  - Copy link uses the clipboard. The share sheet of a phone (`navigator.share`) works only when the editor is on HTTPS; on HTTP only Copy link shows.

## 8. The editor

The look and the behaviour come from the popup UX designer, from the needs of section 10. The word in the UI is "file", never "artifact".

### Where a new file shows

- **Node:** a badge with the count of unseen new files, in the accent colour. It clears when the user opens the Files list of that node. No popup, no focus change, no sound.
- **Chat:** one line at the time of the publish: type icon, title, "New file" or "Version 3", time. An image gets a 48 px thumbnail. A click opens that version in Files. The popup has no fixed "newest" header: the chat line is the preview.
- **Popup:** a 4th tab "Files" with the files of this node, newest first.
- **Sidebar tab:** a "Files" view with the files of all agents of the tab, with filters.

### The list

- A row is 44 px high minimum.
  - Line 1: type icon, title (one line, with an ellipsis).
  - Line 2, in the secondary colour: "Version 3 · 2 min ago". The sidebar list adds the agent name.
- An unseen item has an accent dot at the left. A shared item has the chip "Shared". A deleted item shows "Deleted. Undo" for 10 s, then it goes.
- Filters, in the sidebar only: a search field (title), then Agent, Type, Time (Today, 7 days, 30 days, All). The search field never gets the focus on its own.
- The sidebar Files view only (never the popup) has one line below the list: "Files use 1.2 GB". One decimal, the unit B, KB, MB or GB, no label, no limit, no bar.
  - Look: the secondary text colour and the small font of the editor, aligned left, 8 px padding. The line stays at the bottom and does not scroll with the list.
  - It shows the size of the whole store, also when a filter is on. Files in the bin count until the purge.
  - It updates on the comms topic `claude-agent/artifacts`, with no poll.

### The layout

- Width 500 px or more: the list at the left (40 %), the viewer at the right.
- Less than 500 px: the list only. A tap shows the viewer at full width, with "‹ Files" at the top left.
- The viewer header: title, "Version 3 (newest) ▾", then the buttons Full screen, Download, Share and More. More holds Compare and Delete.
  Each button has a visible label and a height of 44 px. No action is on hover only. On a narrow screen the buttons wrap to a second row.

### The actions

- **Open:** one click on the row. The editor theme goes in the URL.
- **Versions:** a list, newest first: "Version 3 · newest · 18 Nov 14:02". One tap opens an older version.
- **Compare:** "Compare with", with the version before as the default. Side by side on a wide screen, stacked on a narrow screen.
- **Full screen:** the viewer page opens in a new browser tab. In editor mode that page has a "Close" button (`window.close`).
- **Download:** one click, on the download URL of the view server (section 6). The file name is `<title>-v3.<ext>`. A folder downloads as `<title>-v3.zip`.
- **Share:** a panel in the viewer area. It shows "Anyone with the link can open it." and two choices:
  - "This version (3)" (default) or "Always the newest version". While the second choice is selected, the warning of section 7 shows as one line of text below the choices, in the warning colour of the editor. It is not a dialog, and it does not block "Create link".
  - "Ends in": 1 day, 7 days (default) or 30 days.
  - "Create link" shows the preview (the share page in the frame), "Copy link", and "Share…" on HTTPS only.
  - Each open link has one line: "Anyone with the link · Version 3 · ends 25 Nov", or "Anyone with the link · Newest version · ends 25 Nov" for a link that follows the newest version. The line has the buttons "Extend" and "Stop sharing".
  - "Extend" shows the choices 1 day, 7 days and 30 days in the line, counted from now. After the choice, the line shows the new end date. The URL does not change.
  - "Stop sharing" works at once, with no confirm.
  - With no `publicUrl`, the Share button does not show.
- **Shared links:** the sidebar "Files" view has a filter "Shared". It lists all open links of all agents, with the same line and buttons.
- **Delete:** a confirm dialog: "Delete <title>? All 3 versions go to the bin for 30 days. 2 shared links stop now." The buttons are "Delete" (red) and "Cancel". Undo brings back the file and its links that have not expired.

### The viewer page (editor and share link)

- Top bar, 48 px: title, then "Version 3 · 18 Nov 2026" or "Newest version · 18 Nov 2026", then Download. A share page has no agent name, no path and no editor link.
- The content fits the width. The page never scrolls sideways. A table scrolls in its own box.
- Markdown: a wide screen shows the outline as a left column. A narrow screen shows a "Contents" button that opens the list. A tap jumps to the heading.
- The page is never blank. When a type cannot show: "This file cannot show here." and Download.
- A dead link shows one line: "This link does not work."
- Theme: the editor theme from the URL. A share page follows `prefers-color-scheme`. The viewer page has its own copy of the colour values of the editor CSS variables, because it cannot read the editor.

## 9. Settings

`settings.js`, in the block `claudeAgent`:

```js
artifacts: {
    dir: '',                // default <userDir>/claude-agent/artifacts
    viewPort: 1881,         // the view server. 0 or no artifacts block: no viewer, publish still stores.
    viewUrl: '',            // the URL that the browser of the editor uses for the view server. Default: the host of the editor with viewPort.
    sharePort: 0,           // the share server. 0: no share links.
    shareBind: '127.0.0.1', // the address of the share server. Change it only when the public host is on another machine.
    publicUrl: '',          // the public URL of the share server
    htmlNetwork: true,      // HTML on the view server can load https: files
    shareHosts: [],         // hosts that HTML on the share server can load files from
    maxBytes: 104857600,    // 100 MB for each publish
    maxFiles: 2000
},
agentExec: ''               // the program that runs a command as the agent user (section 2)
```

## 10. User needs

Three users gave their needs: an operator who watches many agents, a new user, and a user on a small screen with touch. The design follows them as below.

| Need | Users | Where in the design |
| --- | --- | --- |
| A new artifact never opens a popup, takes the focus or covers the canvas. A small sign on the node and one line in the chat or panel are enough. | all | section 8 |
| The chat shows the publish at its time: title, type in words or icon with word, version, time, agent. | new | event `artifact`, section 8 |
| One list for all agents, newest first, filters for agent, type and time, search by title. Find an old thing in 10 seconds. | watcher | admin API `GET /` with `owner`, `type`, `since`, `q` |
| One stable title for all versions; a clear "newest". | watcher, small screen | the name is the key; the title of the newest version shows |
| Read with one click, fast, inline. A big file or an HTML page must not make the editor slow. | all | the viewer runs in its own frame and process of the other origin; the list loads no content, only an image thumbnail |
| Compare a version with the one before. On a small screen: stacked, not side by side. | all | section 5, compare |
| A wide table scrolls in its own frame with the first column fixed. A long document has an outline. A big image fits and pinch zoom works. | small screen | the renderers of section 5 |
| An HTML application opens full screen in its own page, with a way back. | small screen | the viewer URL opens in a browser tab of its own |
| No version is overwritten. Nothing is lost after a restart or an update. | all | append-only versions, plain files in the user directory |
| Delete asks first, says which share links stop, and has an undo. | all | section 3, delete goes to a bin for 30 days |
| A share link is never made on its own. It says in words who can open it ("anyone with the link"), fixed version or newest, and the end date. It can be stopped at once. | all | section 7 |
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
| 1 | Store, publish tool with the tar reader (local `tar`, or `agentExec` on the host), event `artifact`, global comms topic, admin API list and record | M | `agentExec` on live, because live has a launcher |
| 2 | View server with tickets and headers, download (file and zip), thumbnail URLs in the list, viewer page with the renderers text, markdown, image, PDF, audio, video, HTML, other | L | a second port that the browser reaches |
| 3 | Editor: the card in the chat, the artifacts of a node, the list of all artifacts, open the viewer | M | section 8 |
| 4 | Delete, the bin with undo for 30 days, the purge of blobs, the store size line | M | — |
| 5 | Compare two versions | M | — |
| 6 | Share server, share links and the list of open links | M | a public host for the share port |
| 7 | Read as the agent user in a sandbox (`agentExec` with a sandbox name) | S | the sandbox form of `agentExec` |
| 8 | CSV, TSV and JSON renderers | S | — |
| 9 | Later: syntax colours, Mermaid | S + M | new dependencies |
| 10 | Later: a comment on a version goes to the inbox of its agent as a message | S | the MQTT inbox of the node |

Sizes: S is less than 150 lines with tests, M 150 to 400, L more than 400.

## 12. Open risks

- An agent can publish HTML that tries to trick a person, for example a fake login form. The opaque origin stops access to data, not a lie on the screen. The viewer in the editor shows the agent and the type above each HTML artifact. A share page shows the type only, because it has no agent name (section 7).
- Chrome shows a PDF only outside a sandbox, so a PDF depends on the PDF viewer of the browser for its safety. The type and first byte checks of section 6 limit it to real PDF files.
- A share link to "always the newest version" sends each new version out with no review. It is an explicit choice with a warning. A link has no hard maximum age, because the purpose is long term sharing: "Extend" can keep it open. But each period is 30 days at most, so the link stays open only while a person extends it again.
- The store grows with no limit, because nothing deletes on its own. The admin API list gives the size of each artifact and `totalBytes`. The sidebar Files view shows the total size of the store in one line below the list (section 8).
