import { describe, it, expect } from 'bun:test';
import { gunzipSync, brotliDecompressSync, zstdDecompressSync } from 'node:zlib';
import { compressText } from '../src/runtime/compression.js';
describe('compressed downloads', () => {
  const decoders = { gzip: gunzipSync, brotli: brotliDecompressSync, zstd: zstdDecompressSync };
  for (const [codec, decode] of Object.entries(decoders)) {
    it(`round-trips ${codec} bytes without changing Unicode, nulls, or CSV quoting`, async () => {
      const csv = 'name,details\r\n"Mira, Inc.","日本語 😀 and ""quotes"""\r\n';
      const archive = await compressText(csv, codec as keyof typeof decoders);
      expect(decode(archive).toString()).toBe(csv);
      expect(decode(await compressText('', codec as keyof typeof decoders)).length).toBe(0);
    });
  }
});
