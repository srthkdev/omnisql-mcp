import { performance } from 'node:perf_hooks';
import { readFileSync } from 'node:fs';
import { gunzipSync, brotliDecompressSync, zstdDecompressSync } from 'node:zlib';
import { compressText } from '../dist/runtime/compression.js';
import { convertToCSV } from '../dist/utils.js';
const columns = ['id', 'customer_id', 'amount', 'status', 'note'];
const rows = Array.from({ length: 10000 }, (_, i) => [
  i + 1,
  i % 300,
  ((i * 31) % 100000) / 100,
  ['paid', 'pending', 'refunded'][i % 3],
  `Order ${i + 1}, warehouse ${i % 17}; "approved"`,
]);
const inputs = {
  syntheticCsv: convertToCSV(columns, rows),
  syntheticJson: JSON.stringify(
    rows.map((row) => Object.fromEntries(columns.map((column, i) => [column, row[i]])))
  ),
  minifiedSiteCss: readFileSync('docs-site/build/site.css', 'utf8'),
};
const decoders = { gzip: gunzipSync, brotli: brotliDecompressSync, zstd: zstdDecompressSync };
const report = {
  runtime: process.versions.bun ? `Bun ${process.versions.bun}` : `Node ${process.version}`,
  platform: process.platform,
  arch: process.arch,
  samples: 15,
  corpus: {},
};
const median = (samples) => [...samples].sort((a, b) => a - b)[7];
for (const [name, text] of Object.entries(inputs)) {
  const source = Buffer.from(text);
  const codecs = {};
  for (const [codec, decode] of Object.entries(decoders)) {
    for (let i = 0; i < 3; i++) decode(await compressText(text, codec));
    const encodeMs = [],
      decodeMs = [];
    let archive;
    for (let i = 0; i < 15; i++) {
      let start = performance.now();
      archive = await compressText(text, codec);
      encodeMs.push(performance.now() - start);
      start = performance.now();
      const decoded = decode(archive);
      decodeMs.push(performance.now() - start);
      if (!decoded.equals(source)) throw new Error(`${name}/${codec}: byte mismatch`);
    }
    codecs[codec] = {
      bytes: archive.length,
      encodeMsP50: median(encodeMs),
      decodeMsP50: median(decodeMs),
      encodeSamplesMs: encodeMs,
      decodeSamplesMs: decodeMs,
    };
  }
  report.corpus[name] = { inputBytes: source.length, codecs };
}
console.log(JSON.stringify(report, null, 2));
