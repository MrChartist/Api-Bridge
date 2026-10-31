// A small, strict CSV reader (RFC 4180 style) for the exchange files. No dependencies.
/** Rows of text fields. Handles a byte-order mark, CRLF / LF / CR line ends, quoted fields and doubled quotes. */
export function parseCsv(text) {
    const rows = [];
    let row = [];
    let field = '';
    let quoted = false;
    let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
    const n = text.length;
    const endField = () => {
        row.push(field);
        field = '';
    };
    const endRow = () => {
        endField();
        if (row.length > 1 || row[0].trim() !== '')
            rows.push(row);
        row = [];
    };
    while (i < n) {
        const c = text[i];
        if (quoted) {
            if (c === '"') {
                if (text[i + 1] === '"') {
                    field += '"';
                    i += 2;
                    continue;
                }
                quoted = false;
            }
            else
                field += c;
            i++;
            continue;
        }
        if (c === '"' && field === '')
            quoted = true;
        else if (c === ',')
            endField();
        else if (c === '\n')
            endRow();
        else if (c === '\r') {
            if (text[i + 1] === '\n')
                i++;
            endRow();
        }
        else
            field += c;
        i++;
    }
    if (field !== '' || row.length > 0)
        endRow();
    return rows;
}
