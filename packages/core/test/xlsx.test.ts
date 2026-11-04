import { crc32, inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { buildXlsx, columnName, safeSheetName, xmlText } from '../src/export/xlsx.ts';
import { readZipEntry, zip } from '../src/export/zip.ts';

type ZipFile = { name: string; data: Buffer; flags: number };

/**
 * Reads a zip the way an unzip tool does: end record, then the central
 * directory, then each local header. Checks that the three agree and that
 * every entry inflates to its recorded size and CRC.
 */
function unzip(file: Buffer): ZipFile[] {
  const end = file.length - 22;
  expect(file.readUInt32LE(end)).toBe(0x06054b50);
  const count = file.readUInt16LE(end + 10);
  expect(file.readUInt16LE(end + 8)).toBe(count);
  const centralSize = file.readUInt32LE(end + 12);
  const centralOffset = file.readUInt32LE(end + 16);
  expect(centralOffset + centralSize).toBe(end);
  expect(file.readUInt16LE(end + 20)).toBe(0);

  const files: ZipFile[] = [];
  let at = centralOffset;
  for (let i = 0; i < count; i++) {
    expect(file.readUInt32LE(at)).toBe(0x02014b50);
    const flags = file.readUInt16LE(at + 8);
    const method = file.readUInt16LE(at + 10);
    const crc = file.readUInt32LE(at + 16);
    const compressedSize = file.readUInt32LE(at + 20);
    const size = file.readUInt32LE(at + 24);
    const nameLength = file.readUInt16LE(at + 28);
    const extraLength = file.readUInt16LE(at + 30);
    const commentLength = file.readUInt16LE(at + 32);
    const localOffset = file.readUInt32LE(at + 42);
    const name = file.subarray(at + 46, at + 46 + nameLength);
    expect(method).toBe(8);
    expect(file.readUInt16LE(at + 14)).toBe(33); // 1980-01-01

    expect(file.readUInt32LE(localOffset)).toBe(0x04034b50);
    expect(file.readUInt16LE(localOffset + 6)).toBe(flags);
    expect(file.readUInt16LE(localOffset + 8)).toBe(method);
    expect(file.readUInt32LE(localOffset + 14)).toBe(crc);
    expect(file.readUInt32LE(localOffset + 18)).toBe(compressedSize);
    expect(file.readUInt32LE(localOffset + 22)).toBe(size);
    const localNameLength = file.readUInt16LE(localOffset + 26);
    const localExtraLength = file.readUInt16LE(localOffset + 28);
    expect(file.subarray(localOffset + 30, localOffset + 30 + localNameLength).equals(name)).toBe(true);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const data = inflateRawSync(file.subarray(dataStart, dataStart + compressedSize));
    expect(data.length).toBe(size);
    expect(crc32(data) >>> 0).toBe(crc);

    files.push({ name: name.toString('utf8'), data, flags });
    at += 46 + nameLength + extraLength + commentLength;
  }
  expect(at).toBe(end);
  return files;
}

function unzipText(file: Buffer): Map<string, string> {
  return new Map(unzip(file).map((entry) => [entry.name, entry.data.toString('utf8')]));
}

describe('zip', () => {
  it('round-trips names and contents, including UTF-8 names, Greek text, binary and empty entries', () => {
    const binary = Uint8Array.from({ length: 256 }, (_, i) => i);
    const greek = 'Πατήστε «Σύνδεση» και ελέγξτε ότι εμφανίζεται η αρχική οθόνη.\n';
    const entries = [
      { name: 'plain.txt', data: 'hello zip' },
      { name: 'φάκελος/δοκιμή.txt', data: greek },
      { name: 'bin/all-bytes.bin', data: binary },
      { name: 'empty.txt', data: '' },
      { name: 'repeat.txt', data: 'abc'.repeat(5000) },
    ];
    const files = unzip(zip(entries));
    expect(files.map((file) => file.name)).toEqual(entries.map((entry) => entry.name));
    expect(files.every((file) => file.flags === 0x0800)).toBe(true);
    expect(files[0]!.data.toString('utf8')).toBe('hello zip');
    expect(files[1]!.data.toString('utf8')).toBe(greek);
    expect([...files[2]!.data]).toEqual([...binary]);
    expect(files[3]!.data.length).toBe(0);
    expect(files[4]!.data.toString('utf8')).toBe('abc'.repeat(5000));
  });

  it('writes an empty archive as just the end record', () => {
    const file = zip([]);
    expect(file.length).toBe(22);
    expect(unzip(file)).toEqual([]);
  });

  it('actually compresses', () => {
    const file = zip([{ name: 'big.txt', data: 'same line\n'.repeat(10000) }]);
    expect(file.length).toBeLessThan(2000);
  });
});

describe('columnName', () => {
  it('counts like spreadsheet columns', () => {
    expect([0, 1, 25, 26, 27, 51, 52, 701, 702, 16383].map(columnName)).toEqual(['A', 'B', 'Z', 'AA', 'AB', 'AZ', 'BA', 'ZZ', 'AAA', 'XFD']);
  });
});

describe('xmlText', () => {
  it('escapes markup characters', () => {
    expect(xmlText(`<a href="x">Tom & "Jerry"</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;Tom &amp; &quot;Jerry&quot;&lt;/a&gt;');
    expect(xmlText('&amp;')).toBe('&amp;amp;');
  });

  it('drops characters XML 1.0 cannot carry and keeps tab, newline, carriage return and Greek', () => {
    expect(xmlText('a\u0000b\u0007c\u000bd\u000ce\u001ff\u0008g')).toBe('abcdefg');
    expect(xmlText('x￾y￿z')).toBe('xyz');
    expect(xmlText('line 1\nline\t2\r\n')).toBe('line 1\nline\t2\r\n');
    expect(xmlText('Έλεγχος ότι φαίνεται')).toBe('Έλεγχος ότι φαίνεται');
  });
});

describe('safeSheetName', () => {
  it('replaces forbidden characters, trims and falls back to Sheet', () => {
    const taken = new Set<string>();
    expect(safeSheetName('Steps [draft]: a/b\\c*?', taken)).toBe('Steps  draft   a b c');
    expect(safeSheetName('  ???  ', taken)).toBe('Sheet');
    expect(safeSheetName('', taken)).toBe('Sheet 2');
  });

  it('cuts names to 31 characters', () => {
    const name = 'Submit claim with expired policy and a long tail';
    expect(safeSheetName(name, new Set())).toBe(name.slice(0, 31));
  });

  it('makes names unique without regard to case, and keeps suffixed names within 31 characters', () => {
    const taken = new Set<string>();
    expect(safeSheetName('Cases', taken)).toBe('Cases');
    expect(safeSheetName('cases', taken)).toBe('cases 2');
    expect(safeSheetName('CASES', taken)).toBe('CASES 3');
    const long = 'x'.repeat(40);
    expect(safeSheetName(long, taken)).toBe('x'.repeat(31));
    const second = safeSheetName(long, taken);
    expect(second).toBe(`${'x'.repeat(29)} 2`);
    expect(second.length).toBe(31);
    expect([...taken]).toEqual(['cases', 'cases 2', 'cases 3', 'x'.repeat(31), `${'x'.repeat(29)} 2`]);
  });
});

describe('buildXlsx', () => {
  const workbook = () =>
    unzipText(
      buildXlsx([
        {
          name: 'Cases',
          rows: [
            ['Case', 'Step', 'Action'],
            ['Υποβολή αίτησης', '1', 'Tap "Submit" & <wait>'],
            ['Second', '2'],
          ],
          widths: [36, 6, 54],
        },
        { name: 'cases', rows: [['Only a header']] },
        { name: 'R&D <tests>', rows: [['A'], ['b\u0001c']] },
      ]),
    );

  it('contains every part Excel needs, in order', () => {
    expect([...workbook().keys()]).toEqual([
      '[Content_Types].xml',
      '_rels/.rels',
      'xl/workbook.xml',
      'xl/_rels/workbook.xml.rels',
      'xl/styles.xml',
      'xl/worksheets/sheet1.xml',
      'xl/worksheets/sheet2.xml',
      'xl/worksheets/sheet3.xml',
    ]);
  });

  it('declares each sheet in the content types, the workbook and its relationships', () => {
    const parts = workbook();
    const types = parts.get('[Content_Types].xml')!;
    for (const n of [1, 2, 3]) expect(types).toContain(`<Override PartName="/xl/worksheets/sheet${n}.xml"`);
    expect(types).toContain('PartName="/xl/workbook.xml"');
    expect(types).toContain('PartName="/xl/styles.xml"');
    expect(parts.get('_rels/.rels')).toContain('Target="xl/workbook.xml"');
    const rels = parts.get('xl/_rels/workbook.xml.rels')!;
    for (const n of [1, 2, 3]) expect(rels).toContain(`<Relationship Id="rId${n}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${n}.xml"/>`);
    expect(rels).toContain('<Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>');
  });

  it('makes sheet names safe and unique, and escapes them', () => {
    const book = workbook().get('xl/workbook.xml')!;
    expect(book).toContain('<sheet name="Cases" sheetId="1" r:id="rId1"/>');
    expect(book).toContain('<sheet name="cases 2" sheetId="2" r:id="rId2"/>');
    expect(book).toContain('<sheet name="R&amp;D &lt;tests&gt;" sheetId="3" r:id="rId3"/>');
  });

  it('writes inline string cells with a bold header style and wrapped body style', () => {
    const sheet = workbook().get('xl/worksheets/sheet1.xml')!;
    expect(sheet).toContain('<c r="A1" t="inlineStr" s="1"><is><t xml:space="preserve">Case</t></is></c>');
    expect(sheet).toContain('<c r="C1" t="inlineStr" s="1"><is><t xml:space="preserve">Action</t></is></c>');
    expect(sheet).toContain('<c r="A2" t="inlineStr" s="2"><is><t xml:space="preserve">Υποβολή αίτησης</t></is></c>');
    expect(sheet).toContain('<t xml:space="preserve">Tap &quot;Submit&quot; &amp; &lt;wait&gt;</t>');
    expect(sheet).toContain('<row r="3"><c r="A3" t="inlineStr" s="2"><is><t xml:space="preserve">Second</t></is></c><c r="B3"');
    expect(sheet).toContain('<cols><col min="1" max="1" width="36" customWidth="1"/><col min="2" max="2" width="6" customWidth="1"/><col min="3" max="3" width="54" customWidth="1"/></cols>');
    expect(workbook().get('xl/worksheets/sheet3.xml')).toContain('<t xml:space="preserve">bc</t>');
    const styles = workbook().get('xl/styles.xml')!;
    expect(styles).toContain('<cellXfs count="3">');
    expect(styles).toContain('<font><b/>');
    expect(styles).toContain('wrapText="1"');
  });

  it('freezes the header row and filters over the widest row', () => {
    const sheet = workbook().get('xl/worksheets/sheet1.xml')!;
    expect(sheet).toContain('<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>');
    expect(sheet).toContain('<autoFilter ref="A1:C3"/>');
    // The filter comes after sheetData, as the schema requires.
    expect(sheet.indexOf('<autoFilter')).toBeGreaterThan(sheet.indexOf('</sheetData>'));
    const headerOnly = workbook().get('xl/worksheets/sheet2.xml')!;
    expect(headerOnly).not.toContain('autoFilter');
    expect(headerOnly).not.toContain('<cols>');
    expect(headerOnly).toContain('state="frozen"');
  });

  it('refuses a workbook without sheets', () => {
    expect(() => buildXlsx([])).toThrow(/at least one sheet/);
  });
});

/** A zip built by hand with every entry stored (method 0), and an optional comment after the end record. */
function storedZip(entries: Array<{ name: string; data: string }>, comment = ''): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.from(entry.data, 'utf8');
    const crc = crc32(data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, data);
    centrals.push(central, name);
    offset += 30 + name.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(Buffer.byteLength(comment), 20);
  return Buffer.concat([...locals, directory, end, Buffer.from(comment)]);
}

describe('readZipEntry', () => {
  it('reads back a deflated entry written by zip()', () => {
    const data = 'abc'.repeat(5000);
    expect(readZipEntry(zip([{ name: 'a.txt', data }]), 'a.txt')?.toString('utf8')).toBe(data);
  });

  it('reads binary data byte for byte', () => {
    const binary = Uint8Array.from({ length: 256 }, (_, i) => i);
    expect([...readZipEntry(zip([{ name: 'b.bin', data: binary }]), 'b.bin')!]).toEqual([...binary]);
  });

  it('reads the second of several entries, not the first', () => {
    const archive = zip([
      { name: 'one.txt', data: 'first' },
      { name: 'two.txt', data: 'second' },
      { name: 'three.txt', data: 'third' },
    ]);
    expect(readZipEntry(archive, 'two.txt')?.toString()).toBe('second');
    expect(readZipEntry(archive, 'three.txt')?.toString()).toBe('third');
  });

  it('reads a stored entry', () => {
    const archive = storedZip([{ name: 'plain.txt', data: 'stored, not deflated' }]);
    expect(readZipEntry(archive, 'plain.txt')?.toString()).toBe('stored, not deflated');
  });

  it('reads the second stored entry from the right place', () => {
    const archive = storedZip([{ name: 'a', data: 'AAAA' }, { name: 'b', data: 'BB' }]);
    expect(readZipEntry(archive, 'b')?.toString()).toBe('BB');
  });

  it('gives undefined for a name that is not there, and does not match a prefix', () => {
    const archive = zip([{ name: 'maestro-app.apk.sha', data: 'x' }]);
    expect(readZipEntry(archive, 'maestro-app.apk')).toBeUndefined();
    expect(readZipEntry(archive, 'nope')).toBeUndefined();
  });

  it('gives undefined for an archive with no entries', () => {
    expect(readZipEntry(zip([]), 'a')).toBeUndefined();
  });

  it('throws for a buffer that is not a zip', () => {
    expect(() => readZipEntry(Buffer.from('this is not a zip file at all, just text'), 'a')).toThrow('Not a zip file');
    expect(() => readZipEntry(Buffer.alloc(0), 'a')).toThrow('Not a zip file');
  });

  it('finds the end record when the archive has a comment after it', () => {
    const archive = storedZip([{ name: 'a.txt', data: 'with a comment' }], 'built by hand, with a comment');
    expect(readZipEntry(archive, 'a.txt')?.toString()).toBe('with a comment');
  });

  it('copies stored data rather than pointing into the archive', () => {
    const archive = storedZip([{ name: 'a.txt', data: 'abc' }]);
    const entry = readZipEntry(archive, 'a.txt')!;
    archive.fill(0);
    expect(entry.toString()).toBe('abc');
  });
});
