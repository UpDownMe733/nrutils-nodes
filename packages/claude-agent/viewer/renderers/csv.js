// CSV and TSV: a table that scrolls in its own box, with a fixed header row, a fixed first column
// and a sort for each column. The first row is the header row.
'use strict';

(function () {
    const MAX_ROWS = 5000;

    // Reads CSV or TSV text into rows of cells (RFC 4180: quotes, "" in quotes, line breaks in quotes)
    function parse(text, sep) {
        const rows = [];
        let row = [], cell = '', quoted = false, i = 0;
        if (text.charCodeAt(0) === 0xfeff) i = 1;
        for (; i < text.length; i++) {
            const c = text[i];
            if (quoted) {
                if (c !== '"') cell += c;
                else if (text[i + 1] === '"') { cell += '"'; i++; }
                else quoted = false;
            } else if (c === '"' && cell === '') quoted = true;
            else if (c === sep) { row.push(cell); cell = ''; }
            else if (c === '\n' || c === '\r') {
                if (c === '\r' && text[i + 1] === '\n') i++;
                row.push(cell); rows.push(row); row = []; cell = '';
            } else cell += c;
        }
        if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
        return rows;
    }

    const NUMBER = /^\s*[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?\s*$/;
    const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

    // Compares two cells: numbers as numbers, else as text. dir: 1 up, -1 down. An empty cell is last in the two directions.
    function compare(a, b, dir = 1) {
        if (a === '' || b === '') return (a === '') - (b === '');
        if (NUMBER.test(a) && NUMBER.test(b)) return (parseFloat(a) - parseFloat(b)) * dir;
        return collator.compare(a, b) * dir;
    }

    viewer.register({
        name: 'csv',
        cuts: true,
        parse, compare,
        match: (file) => file.type === 'text/csv' || file.type === 'text/tab-separated-values',
        render: async (box, file, ctx) => {
            const rows = parse(await ctx.text(file.path), file.type === 'text/csv' ? ',' : '\t');
            if (!rows.length) return viewer.fallback(box, file, 'This table is empty.');
            const head = rows[0], body = rows.slice(1);
            const width = Math.max(...rows.slice(0, MAX_ROWS + 1).map(r => r.length));
            const order = body.map((r, i) => i);
            let sortCol = -1, sortDir = 0;

            const table = viewer.el('table', { class: 'grid' });
            const thead = viewer.el('thead');
            const tbody = viewer.el('tbody');
            const note = viewer.el('div', { class: 'secondary' });

            function fill() {
                const frag = document.createDocumentFragment();
                for (const i of order.slice(0, MAX_ROWS)) {
                    const tr = viewer.el('tr');
                    for (let c = 0; c < width; c++) tr.append(viewer.el('td', { text: body[i][c] || '' }));
                    frag.append(tr);
                }
                tbody.replaceChildren(frag);
            }

            // One click: up, then down, then the order of the file
            function sort(c) {
                sortDir = sortCol === c ? (sortDir + 1) % 3 : 1;
                sortCol = sortDir ? c : -1;
                order.sort((a, b) => sortDir ? (compare(body[a][c] || '', body[b][c] || '', sortDir === 1 ? 1 : -1) || a - b) : a - b);
                for (const [k, th] of [...thead.querySelectorAll('th')].entries()) {
                    th.setAttribute('aria-sort', k === sortCol ? (sortDir === 1 ? 'ascending' : 'descending') : 'none');
                }
                fill();
            }

            const tr = viewer.el('tr');
            for (let c = 0; c < width; c++) {
                const button = viewer.el('button', { type: 'button', text: head[c] || '' });
                button.addEventListener('click', () => sort(c));
                tr.append(viewer.el('th', { scope: 'col', 'aria-sort': 'none' }, button));
            }
            thead.append(tr);
            table.append(thead, tbody);
            fill();
            note.textContent = body.length + (body.length === 1 ? ' row' : ' rows') + ', ' + width + (width === 1 ? ' column' : ' columns') +
                (body.length > MAX_ROWS ? '. The table shows the first ' + MAX_ROWS + ' rows. Download the file for all rows.' : '');
            box.replaceChildren(viewer.el('div', { class: 'tools' }, note), viewer.el('div', { class: 'grid-box' }, table));
        }
    });
})();
