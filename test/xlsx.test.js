import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inflateRawSync } from 'node:zlib';
import { xlsx } from '../web/src/xlsx.mjs';

// Reads the stored zip back: { name: text }.
function unzip(buf) {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength), out = {};
  const end = buf.length - 22;
  assert.equal(v.getUint32(end, true), 0x06054b50);
  let at = v.getUint32(end + 16, true);
  for (let i = 0; i < v.getUint16(end + 10, true); i++) {
    assert.equal(v.getUint32(at, true), 0x02014b50);
    const size = v.getUint32(at + 20, true), nlen = v.getUint16(at + 28, true), local = v.getUint32(at + 42, true);
    const name = new TextDecoder().decode(buf.slice(at + 46, at + 46 + nlen));
    const start = local + 30 + v.getUint16(local + 26, true);
    out[name] = new TextDecoder().decode(v.getUint16(local + 8, true) ? inflateRawSync(buf.slice(start, start + size)) : buf.slice(start, start + size));
    at += 46 + nlen;
  }
  return out;
}

test('an xlsx file has the workbook, styles and one sheet per table', () => {
  const files = unzip(xlsx([
    { name: 'Days', cols: [{ header: 'Date', fmt: 'date' }, { header: 'Distance km', fmt: 'dec1' }, { header: 'Note' }],
      rows: [['2026-10-01', 12.345, 'a & b <c>'], ['2026-10-02', null, '']] },
    { name: 'Charging', cols: [{ header: 'Start', fmt: 'datetime' }], rows: [[Date.UTC(2026, 9, 1, 12)]] },
  ]));
  assert.deepEqual(Object.keys(files).sort(), ['[Content_Types].xml', '_rels/.rels', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml',
    'xl/workbook.xml', 'xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml'].sort());
  assert.match(files['xl/workbook.xml'], /<sheet name="Days" sheetId="1" r:id="rId1"\/><sheet name="Charging"/);
  const s1 = files['xl/worksheets/sheet1.xml'];
  assert.match(s1, /<c r="A2" s="2"><v>46296<\/v><\/c>/); // 1 Oct 2026 as an Excel day
  assert.match(s1, /<c r="B2" s="5"><v>12.345<\/v><\/c>/);
  assert.match(s1, /a &amp; b &lt;c&gt;/);
  assert.match(s1, /<row r="3"><c r="A3" s="2"><v>46297<\/v><\/c><\/row>/); // empty cells left out
  assert.match(files['xl/worksheets/sheet2.xml'], /<c r="A2" s="3"><v>46296\.\d+<\/v><\/c>/);
});
