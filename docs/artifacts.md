# Artifacts of the claude-agent node (design)

Status: parts 1 to 5, 7, 8 and 11 of section 11 are built. Parts 6, 9 and 10 are not built.

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

The admin API sends no byte of an artifact. The admin origin holds the token of the editor: an HTML file there, or a `blob:` URL that the editor makes from artifact bytes, would run with that token. Thus the content, the thumbnails and the downloads come only from the view server. The list has no thumbnail URL. When the row of an image shows on the screen, the editor sends `POST /:id/:n/ticket`, then loads `<view URL>thumb`.

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
7. **Messages.** The editor accepts a `postMessage` only when `event.origin` is the origin of the view server. It accepts only data (for example "loaded"), never a command. The viewer page sends "loaded" as soon as its script runs. When the frame of the editor gets no "loaded" in 8 s, the editor hides the frame and shows "The viewer did not load. Check that the view server runs." A later "loaded" shows the frame again. The editor sends no extra request for this check.

The PDF exception: Chrome does not show a PDF in a sandboxed document, so a PDF response has no `sandbox` CSP. The view server serves a file as PDF only when its type is exactly `application/pdf` and its first bytes are `%PDF-`. The response has `nosniff`. Else the file is served as `application/octet-stream` with the sandbox CSP.

Download: `/v/<ticket>/download` gives the file, or a zip of the folder, with `Content-Disposition: attachment; filename=…`, `Content-Type: application/octet-stream`, `nosniff` and the sandbox CSP.

Thumbnail: `/v/<ticket>/thumb` gives the entry file with the headers of each file response (layers 3 and 5). When the entry file is not an image, or is larger than 1 MB, it gives 404.

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
  - The editor has one list of all open share links of all artifacts, with the end date of each and a revoke action. A link of a deleted artifact or version shows "Stopped: file deleted" in this list and in the share panel. Its line is in the secondary colour and has no "Extend" button. It keeps "Stop sharing", so a person can undo the delete of a file and not bring back its link. When its end date passes while the file is in the bin, the undo does not bring it back. The chip "Shared" counts only links that work now.
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
  - Line 2, in the secondary colour: "Version 3 · 14:07 · 120 KB", with the agent address in the sidebar. The time is the clock time for today and "18 Nov 14:07" for an earlier day.
- An image of 1 MB or less shows a 48 px thumbnail in its row. The thumbnail loads from the `/thumb` route of the view server (section 6) only when the row shows on the screen.
- A new item has an accent dot at the left. An item is new when its server time is later than the newest time that the user saw for its node, and the user did not open it. The editor keeps both in `localStorage` (per browser). Opening the Files list of a node sets the time. The badge on the node counts the same items. A shared item has the chip "Shared". A deleted item shows "Deleted. Undo" for 10 s, then it goes.
- Filters, in the sidebar only: a search field (title, name, agent address, type name), then Agent, Type, Time (Today, 7 days, 30 days, All) and Sort (Newest, Largest, Name). The popup list has the search field only when the node has more than 8 files. The search field never gets the focus on its own.
- The sidebar Files view only (never the popup) has one line below the list: "11 files · 894.2 KB", or "3 of 11 files · 894.2 KB" when a filter is on. One decimal, the unit B, KB, MB or GB, no label, no limit, no bar.
  - Look: the secondary text colour and the small font of the editor, aligned left, 8 px padding. The line stays at the bottom and does not scroll with the list.
  - The size is the size of the whole store, also when a filter is on. Files in the bin count until the purge.
  - It updates on the comms topic `claude-agent/artifacts`, with no poll.

### The layout

- Width 900 px or more: the list at the left (40 %), the viewer at the right.
- Less than 900 px: the list only. A tap shows the viewer at full width, with "‹ Files" at the top left.
- The viewer header: title, "Version 3 (newest) ▾", then the buttons Full screen, Download, Copy link, New tab, Share (part 6, not built yet), Compare and Delete. "New tab" has the accessible name "Open in new tab". At 1280 px the header is one line. There is no More menu. Delete is at the end, after a gap. The agent address is below the title.
  Each button has a visible label. Its height is 44 px on a coarse pointer (touch) and 32 px on a fine pointer (mouse). The buttons of the compare bar have the same heights. No action is on hover only. On a narrow screen the buttons wrap to a second row.

### The actions

- **Open:** one click on the row. The editor theme goes in the URL.
- **Versions:** a list, newest first: "Version 3 · 14:02 (newest)". The time has the form of the list rows: the time for today, else the date. One tap opens an older version. Then the row of the file shows "Version 1 of 3".
- **Compare:** "Compare with", with the version before as the default. Side by side on a wide screen, stacked on a narrow screen.
- **Full screen:** the pane gets the class `caf-full` and fills the editor window. On the Files page and in the sidebar the pane does not move, so the frame does not reload. The popup is in an SVG `foreignObject`, where a fixed position fills only the popup. Thus in the popup the pane moves to the body, and the frame loads again. When the popup closes, full screen ends and the pane goes away. It keeps the version list, Compare and Copy link. Close and Escape end it. New tab opens the viewer page in a browser tab. The viewer page has no Close button. On a share link, `window.close()` does nothing.
- **Copy link:** at a click only, the editor asks for a new view ticket and copies the view URL with no `embed` and no theme. It says: "Link copied. Anyone with this link can open this version for 12 hours."
- **Keys:** Ctrl+G F shows the Files tab and Ctrl+G A shows the Claude agent tab.
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
  When `meta.newest` is false, the version text ends with " · A newer version exists". The view server and the share server both send `newest`. On a view link, "All files" opens the Files page, where the version list marks the newest.
  The frame of the editor adds `embed=1` to the URL. Then the page hides its top bar, because the viewer header of the editor has the same items.
- The content fits the width. The page never scrolls sideways. A table scrolls in its own box.
- Markdown: a wide screen shows the outline as a left column. A narrow screen shows a "Contents" button that opens the list. A tap jumps to the heading.
- The page is never blank. When a type cannot show: "This file cannot show here." and Download.
- A dead link shows one line: "This link does not work."
- Theme: the editor theme from the URL. A share page follows `prefers-color-scheme`. The viewer page has its own copy of the colour values of the editor CSS variables, because it cannot read the editor.
- A view link (`/v/`, with no `embed`) has a second line in the top bar: "By <address> · All files". The line is 24 px high, in the small font and the secondary colour. "All files" is an accent link with a 44 px target on touch. No icon. The top bar is then 72 px. The link opens the Files page of the editor on this file and version (see "The Files page"). A share page has neither.
  - `meta` of the view server gives `owner` (the address) and `editor` (the URL of the Files page). The share server gives neither, and no `note` (section 7: a share page shows title, version, date and content).
  - Each server builds `meta` from its own allow list of keys. A test checks the exact key set of a share `meta`.
  - `editor` is `<origin><httpAdminRoot>#files/<id>/<n>`. `index.js` gives the view server `RED.settings.httpAdminRoot`, with a trailing "/". The origin is the editor origin that the view server knows (the same list as for `frame-ancestors`, section 6) whose hostname is the hostname of the request. When no known origin has that hostname, `meta` has no `editor` and the page shows no link. There is no "newest origin" fallback: a wrong host gives a link that does not work.
  - `meta` keeps `Cache-Control: no-store`, because its content changes with the host of the request.
  - The page writes the address with `textContent`. The link opens in the same browser tab. The editor asks for the login when the browser has none.

### The Files page

The operator keeps the sidebars off, or holds only a view link. Then no place shows which agent has a file. The Files page is the sidebar Files view (`build({ all: true })`, section "The list") at the full size of the editor window. It is one more view of the same code, not a new list.

- **Open:**
  - the URL `<editor>/#files`, for a bookmark or a browser tab of its own (a second screen);
  - the URL `<editor>/#files/<id>/<n>`, which also opens that version and sets the Agent filter to the owner of the file (the "All files" link of a view link). A link of version 1 opens version 1: the version list marks the newest;
  - the key Ctrl+G Shift+F and the item "Files page" in the View menu of the editor (`RED.menu`; the sidebar tab already has the item "Files"; action `claude-agent:show-files-page`). The build proves that `RED.keyboard` reads "ctrl-g shift-f". When it does not, the key is Ctrl+G Ctrl+F.
  - the button "Files" in the header of the editor, directly left of Deploy, and the key Alt+Shift+F (see "Direct open").
  - Node-RED reads only `#flow/`, `#node/` and `#group/`, and it sets `#flow/<tab>` while the flows load. Thus the node keeps `location.hash` when its script loads, and opens the page after `flows:loaded`.
  - While the page is open, the hash is `#files` or `#files/<id>/<n>`, so a reload keeps the page. The node sets the hash again after `flows:loaded` and after each change of the workspace. A `hashchange` to `#files…` opens the page in an open editor.
- **Strict input:** the id must match `^[0-9a-f]{16}$` and the version must be an integer. The node checks the hash and a pasted ticket with these patterns before it uses a value in an API path or in the page. A value that does not match is ignored.
- **Build:** the page view is built one time, at the first open, and kept. `build()` adds to the list of views and never removes one.
- **Layout:** a layer over the whole editor window, the same as `caf-full`. The list at the left, the viewer at the right; less than 900 px wide, one column: the list full width, and an open file covers the list. The limit is the same as in the sidebar (section 8, "The layout"). The page never scrolls sideways at 200 % zoom. The canvas does not reload.
- **Header:** a 48 px bar with the primary background and a 1 px bottom border in the secondary border colour. "Files" at the left, 16 px bold. The text button "Close" at the right: 32 px for the mouse, 44 px on touch. No count.
- **Focus and keys:** the search field gets the focus at each open of the page. The page is opened on purpose, so this does not break the rule "the search field never gets the focus on its own". Arrows move in the list. Enter opens the file. The open row scrolls into view (`block: nearest`). Each select has an `aria-label`: Agent, Type, Time, Sort, Version. The focus stays in the page (a focus trap). The layer stops each keydown, so the keys of the editor do not act.
- **Escape:** one handler for the page. Escape closes the innermost layer first: the full-screen viewer, then the page. The page keeps "Full screen".
- **Search:** title, name, agent address (it has the tab name) and type name, as in the sidebar. A pasted view link or ticket finds its file: the editor reads the id and the version from the first part of the ticket (section 6), with no request. That version opens. A pasted link or a hash open clears each filter that hides the file. The node makes no request from the fields of a ticket.
- **Rows:** the same rows as the sidebar: the agent address is always on line 2. The text for the screen reader starts with the title, then the type in words, the agent, the version, the time, then "newest" or "older version", then "new" when the row is new.
- **Show agent:** in the viewer header of the Files page and of the sidebar, on the agent line below the title: "<address> · Show agent". "Show agent" is an accent text button. It ends full screen, closes the page, calls `RED.view.reveal(id)`, and opens the popup of the node the same way as a click on the node (not `RED.editor.edit`, which is the edit dialog). The node finds the node with `RED.nodes.node(id)`, never with the id in a selector. When the node no longer exists, the line shows "Agent removed" in plain secondary text, with no button.
- **Close:** Escape and "Close" show the canvas and set the hash of the active tab.
- The viewer is the same iframe with the same sandbox as in the sidebar. There is no second viewer. The node never sets `innerHTML` from file data.
- The badges, the "new" marks and the actions (versions, compare, download, copy link, delete) are those of the sidebar. The page adds no filter: the users asked for one search box and "newest first", which the sidebar already has. Equal times sort by title, then by id.
- No new route and no new data: the page uses the admin API of section 4 with the login of the editor.
- **Proof:** pictures from a git worktree in the sandbox with a test Node-RED: the page, a reload on `#files/<id>/<n>`, and the login on that URL with `adminAuth`.

#### Direct open (2026-11-20)

The operator found the View menu hard. All 6 users (power-developer, without-sidebars, keyboard-low-vision, team-watcher, newcomer, small-screen) look first for a button in the top bar near Deploy. Two of them want one key. All 6 keep the menu item, Ctrl+G Shift+F and `#files`, and want no second copy and no reload.

- **Button:** `<li><a id="red-ui-header-button-claude-agent-files" class="button caf-headbtn" href="#">` with the icon `fa-folder-open-o` and the word "Files". It goes directly left of the `li` of `#red-ui-header-button-deploy`, in the init of the node. When Deploy is not there, it goes first in `.red-ui-header-toolbar`. A click calls the action `claude-agent:show-files-page`. It is a link, so Enter and Space work. No tooltip and no count. It has a focus ring. On touch it is 40 px high (the full header) and 44 px or more wide. Less than 480 px wide, a visually-hidden clip hides the word, so the word stays the name of the link. Header colours only.
- **Key:** Alt+Shift+F, the same action. Node-RED 5.0.9 does not use it. `RED.keyboard` reads the key code, so it works on a Mac.
- **Page already open:** no second layer and no new render (`buildPage()` makes the list one time). The search text, the filters, the open file and the scroll stay. The focus goes to Search and its text is selected. The page layer stops each keydown, so its own keydown handler gets Alt+Shift+F. A change of the key in Settings > Keyboard has no effect inside the page. The page covers the header, so the button cannot get the focus then.
- No new route and no new link address: the button calls an action that exists.
- **Narrow header:** Node-RED gives the logo an inline width of 207 px, so its toolbar did not fit at 375 px before the Files button. Less than 480 px wide, the logo gets its natural width. Less than 400 px wide, Deploy shows only its icon: a visually-hidden clip keeps its word as its name. Less than 400 px wide, `#red-ui-header-tabs` can shrink (`min-width:0`, `overflow:hidden`), its tab strip and scroll buttons are hidden (the + and the Tab menu stay: on a narrow screen the Tab menu is the only flow switch, and it opens at the left edge, so it stays in the screen), and the toolbar has no left margin and a 4 px gap. Less than 241 px wide, the logo and `#red-ui-header-tabs` are hidden (`display:none !important`, because Node-RED sets an inline display); Ctrl+Shift+F still lists the flows. The header thus fits 320 px with no zoom-out on touch, and the menu button stays in view at 375 px with 200 % zoom (188 CSS px).
- **Edit tray:** the `li` of the button is above `#red-ui-header-shade`. The button thus works while an edit tray is open. The page opens over the tray. Close and Escape put the focus back on the element that had it before the open, when it still exists and it is not the page body; else on the canvas. The first open also keeps that element.
- **Keys where the editor gets none:** the page layer, each agent popup and the sidebar panel stop the keys before `RED.keyboard`. Thus each one tests the key itself. The page layer calls `filesKey(e)`: Alt+Shift+F, or Shift+F 2 s or less after Ctrl+G. A popup and the sidebar accept only Alt+Shift+F, so Ctrl+G keeps its browser action there.
- **Escape** in Search does not clear the search text. Thus after a new open, the search text and the filter agree.
- **Not taken:** a count on the button (the sidebar tab has the dot); an "open full page" link in the sidebar tab (one user; the header button is in view there too); Ctrl+K (the browser uses it).

| Who | Opinion | What it changed |
|---|---|---|
| popup-ux-designer | design | the button, its place and its sizes; the key; the open-page behaviour |
| claude-agent-dev | OK | `openPage()` never renders the list: `buildPage()` makes it at the first open; the header code goes in the init that exists, with the fallback |
| code-reviewer | changes | the layer keydown handles Alt+Shift+F, because the layer stops the key before `RED.keyboard`; a visually-hidden clip hides the word, so the link needs no `aria-label` (not `display:none`) |

User study round 8 (2026-11-20, build f2e594a, 6 users). Each user found the page: 5 saw the button at once, and 2 used a key (one user did both). Corrections: the button under the header shade of an edit tray (4 users); Alt+Shift+F in an agent popup; an empty Search with a filtered list after a new open (3 users); Ctrl+G Shift+F in the open page. Not taken: a 44 px height (the header is 40 px); a page link in the popup.

#### Opinions on the Files page (2026-11-19)

| Who | Opinion | What it changed |
|---|---|---|
| security-reviewer | OK with conditions | the strict id and version patterns; no request from a ticket; no `innerHTML`; `RED.nodes.node(id)` and no selector; the same viewer iframe; `Cache-Control: no-store` on `meta` |
| code-reviewer | changes | the page is built one time; one Escape handler, innermost layer first; the focus trap; the hash is set again after `flows:loaded` and a workspace change; the proof of reload and login; the editor link matches the hostname only, with no fallback |
| claude-agent-dev | OK | the layer stops the keys; the key is free in the package; `RED.menu`; size 150 to 220 lines. Its proposal "read the hash at `flows:loaded`" is not taken: Node-RED can set `#flow/` during the load |
| artifact-viewer-dev | OK | `index.js` gives `httpAdminRoot`; an allow list of `meta` keys for each server and a test of the share key set; size S (about 40 lines). Its proposal "open in a new tab" is not taken: the Files page opens the same file, so the same tab is correct |
| popup-ux-designer | design | the page header; "Show agent" on the agent line and "Agent removed"; the 72 px top bar of a view link; the key fallback; "Full screen" stays |


#### User study of the built page, round 2 (2026-11-19)

Users: without-sidebars, power-developer, keyboard-low-vision and team-watcher did all goals. Each was satisfied except for the points below. The outside reader waits for the share server (part 6). popup-ux-designer wrote the corrections.

| Finding | Users | Correction |
|---|---|---|
| "All files" shows the files of all agents | without-sidebars, power, keyboard | the hash open sets the Agent filter to the owner |
| A paste keeps a filter that hides the file | watcher | a paste or a hash open clears that filter |
| Two "Files" items in the View menu | watcher | the page item is "Files page" |
| The open row is out of view; the selects have no name for a screen reader | keyboard | `scrollIntoView`, `aria-label` |
| Show agent from full screen opens the popup behind the full screen | power | Show agent ends full screen first |
| Full screen in the popup hides only the header of the popup | power | full screen fills the window there too |
| "All files" from a version 1 link opens version 1 | watcher | no change: the link is of one version, and the version list marks the newest |
| The sidebars show again after a reload | without-sidebars | no change: Node-RED keeps this, and the page covers them |

#### User study of the built page, round 3 (2026-11-19)

without-sidebars and power-developer were satisfied. team-watcher was satisfied except for the empty list. keyboard-low-vision was not satisfied. The outside reader waits for the share server (part 6).

| Finding | Users | Correction |
|---|---|---|
| A filter gives an empty list with no way out | watcher, power | "No files." and the button "Clear filters" (Search, Agent, Type, Time) |
| Search has no focus ring after a link open or a reload | keyboard | the outline is on `:focus`, not only on `:focus-visible` |
| The row shows Version 3 while the viewer shows version 1 | watcher | the row shows "Version 1 of 3" |
| The viewer header takes two lines at 1280 px | designer | the select does not grow; "New tab"; short times |
| A filter change is silent for a screen reader | keyboard | the footer count has `aria-live="polite"` |
| After Show agent the focus is on the canvas | keyboard | the focus goes to the message box of the popup |
| The Contents links of the viewer are `#` | keyboard | each link is `#file=<path>&at=<heading>` |

#### User study of the built page, round 4 (2026-11-19)

power-developer was satisfied. The round 3 corrections are proven in a browser. Three points were left:

| Finding | Users | Correction |
|---|---|---|
| After "All files", the list has no filter for about 3 s, and the row says "Version null of 3" | watcher | the hash open sets the Agent filter from the item at once; no "of" text before a version is open |
| Search and the chat box have only a placeholder as their name | keyboard | `aria-label` "Search files" and a label on the chat box |
| The viewer of an older version does not say that newer versions exist | without-sidebars, watcher | " · A newer version exists" in the top bar |

#### User study of the built page, round 5 (2026-11-19)

The list GET had a delay of 3 s. team-watcher, keyboard-low-vision and without-sidebars were satisfied. power-developer was satisfied in round 4. No correction is left. The outside reader waits for the share server (part 6). Wishes that are not taken: a link to the newest version in the viewer, because a view link can go outside; a "Loading" text in the empty list.

## 9. Settings

`settings.js`, in the block `claudeAgent`:

```js
artifacts: {
    dir: '',                // default <userDir>/claude-agent/artifacts
    viewPort: 1881,         // the view server. 0 or no artifacts block: no viewer, publish still stores.
    viewHost: '',           // the address that the view server listens on. Default: uiHost of Node-RED, else all addresses.
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
| With the sidebars off, or with only a view link, find any file and its agent. One search box and "newest first" are enough. | no sidebars, watcher, power, keyboard | the Files page, section 8 |
| The place is in the editor and also in a browser tab of its own: a bookmark, a second screen, 200 % zoom with no sideways scroll. | all four | the URL `#files` |
| A view link shows the agent and leads to all files and to the other versions of the file. | no sidebars, watcher, keyboard | the top bar of a view link, section 8 |
| A pasted link finds its file. | power, keyboard | the search of the Files page |
| Go from a file to its agent in one click. | no sidebars, watcher, power, keyboard | "Show agent" |
| An outside person never sees an agent name or other files. The place to find files is for the operator only. | outside | the share page has no `owner` and no "All files" |

## 11. The build order

| # | Part | Size | Needs |
| --- | --- | --- | --- |
| 1 | Store, publish tool with the tar reader (local `tar`, or `agentExec` on the host), event `artifact`, global comms topic, admin API list and record | M | `agentExec` on live, because live has a launcher |
| 2 | View server with tickets and headers, download (file and zip), the thumbnail route, viewer page with the renderers text, markdown, image, PDF, audio, video, HTML, other | L | a second port that the browser reaches |
| 3 | Editor: the card in the chat, the artifacts of a node, the list of all artifacts, open the viewer | M | section 8 |
| 4 | Delete, the bin with undo for 30 days, the purge of blobs, the store size line | M | — |
| 5 | Compare two versions | M | — |
| 6 | Share server, share links and the list of open links | M | a public host for the share port |
| 7 | Read as the agent user in a sandbox (`agentExec` with a sandbox name) | S | the sandbox form of `agentExec` |
| 8 | CSV, TSV and JSON renderers | S | — |
| 9 | Later: syntax colours, Mermaid | S + M | new dependencies |
| 10 | Later: a comment on a version goes to the inbox of its agent as a message | S | the MQTT inbox of the node |
| 11 | The Files page: (a) `meta` with `owner` and `editor`, and the agent line and "All files" in the top bar of a view link (artifact-viewer-dev, S); (b) the page, the hash, the key, the menu item, the link search and "Show agent" in the editor (claude-agent-dev, M) | S + M | (a) and (b) can be built at the same time |

Sizes: S is less than 150 lines with tests, M 150 to 400, L more than 400.

## 12. Open risks

- An agent can publish HTML that tries to trick a person, for example a fake login form. The opaque origin stops access to data, not a lie on the screen. The viewer in the editor shows the agent and the type above each HTML artifact. A share page shows the type only, because it has no agent name (section 7).
- Chrome shows a PDF only outside a sandbox, so a PDF depends on the PDF viewer of the browser for its safety. The type and first byte checks of section 6 limit it to real PDF files.
- A share link to "always the newest version" sends each new version out with no review. It is an explicit choice with a warning. A link has no hard maximum age, because the purpose is long term sharing: "Extend" can keep it open. But each period is 30 days at most, so the link stays open only while a person extends it again.
- The store grows with no limit, because nothing deletes on its own. The admin API list gives the size of each artifact and `totalBytes`. The sidebar Files view shows the total size of the store in one line below the list (section 8).
