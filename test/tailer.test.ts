import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { JsonlTailer } from '../src/providers/claude/jsonlTailer.js';
import { basicRecords, tmpDir, toJsonl } from './helpers.js';

describe('JsonlTailer', () => {
  it('returns only complete lines and keeps the offset at the last newline', async () => {
    const dir = tmpDir();
    const f = path.join(dir, 'a.jsonl');
    fs.writeFileSync(f, '{"type":"a"}\n{"type":"b"');
    const t = new JsonlTailer(f);
    let r = await t.pull();
    expect(r.lines).toEqual(['{"type":"a"}']);
    expect(t.offset).toBe('{"type":"a"}\n'.length);
    r = await t.pull();
    expect(r.lines).toEqual([]);
    fs.appendFileSync(f, '}\n{"type":"c"}\n');
    r = await t.pull();
    expect(r.lines).toEqual(['{"type":"b"}', '{"type":"c"}']);
    expect(t.offset).toBe(fs.statSync(f).size);
  });

  it('handles CRLF and blank lines', async () => {
    const dir = tmpDir();
    const f = path.join(dir, 'a.jsonl');
    fs.writeFileSync(f, '{"a":1}\r\n\r\n{"b":2}\r\n');
    const r = await new JsonlTailer(f).pull();
    expect(r.lines).toEqual(['{"a":1}', '{"b":2}']);
  });

  it('does not split multibyte characters', async () => {
    const dir = tmpDir();
    const f = path.join(dir, 'a.jsonl');
    const line = JSON.stringify({ t: '日本語テキスト'.repeat(50) });
    const buf = Buffer.from(`${line}\n`, 'utf8');
    fs.writeFileSync(f, buf.subarray(0, buf.length - 7)); // cut inside a multibyte char
    const t = new JsonlTailer(f);
    expect((await t.pull()).lines).toEqual([]);
    fs.appendFileSync(f, buf.subarray(buf.length - 7));
    expect((await t.pull()).lines).toEqual([line]);
  });

  it('reports truncation and resets', async () => {
    const dir = tmpDir();
    const f = path.join(dir, 'a.jsonl');
    fs.writeFileSync(f, '{"a":1}\n{"b":2}\n');
    const t = new JsonlTailer(f);
    await t.pull();
    fs.writeFileSync(f, '{"c":3}\n');
    const r = await t.pull();
    expect(r.reset).toBe(true);
    expect(t.offset).toBe(0);
    expect((await t.pull()).lines).toEqual(['{"c":3}']);
  });

  it('yields every line exactly once across random split points', async () => {
    const content = toJsonl(basicRecords());
    const buf = Buffer.from(content, 'utf8');
    for (let trial = 0; trial < 20; trial++) {
      const dir = tmpDir();
      const f = path.join(dir, 'a.jsonl');
      const cuts = [...new Set(Array.from({ length: 5 }, () => Math.floor(Math.random() * buf.length)))].sort((a, b) => a - b);
      fs.writeFileSync(f, '');
      const t = new JsonlTailer(f);
      const got: string[] = [];
      let pos = 0;
      for (const c of [...cuts, buf.length]) {
        fs.appendFileSync(f, buf.subarray(pos, c));
        pos = c;
        got.push(...(await t.pull()).lines);
      }
      expect(got).toEqual(content.trimEnd().split('\n'));
    }
  });
});
