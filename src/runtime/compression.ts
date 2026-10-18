import { gzip, brotliCompress, zstdCompress, constants } from 'node:zlib';
import { QueryGate } from './concurrency.js';

export type ExportCompression = 'none' | 'gzip' | 'brotli' | 'zstd';
const gate = new QueryGate(2, 8);
/** Explicit download compression; MCP messages always remain ordinary JSON. */
export async function compressExport(
  text: string,
  compression: Exclude<ExportCompression, 'none'>,
  timeout = 30000
): Promise<Buffer> {
  const release = await gate.acquire(timeout);
  try {
    if (Buffer.byteLength(text) > 16 * 1024 * 1024)
      throw new Error('Export exceeds the 16 MiB compression limit');
    const data = Buffer.from(text);
    return await new Promise<Buffer>((resolve, reject) => {
      const done = (error: Error | null, result: Buffer) =>
        error ? reject(error) : resolve(result);
      if (compression === 'gzip') gzip(data, { level: 6 }, done);
      else if (compression === 'brotli')
        brotliCompress(data, { params: { [constants.BROTLI_PARAM_QUALITY]: 5 } }, done);
      else zstdCompress(data, { params: { [constants.ZSTD_c_compressionLevel]: 3 } }, done);
    });
  } finally {
    release();
  }
}
export const compressionExtension = { none: '', gzip: '.gz', brotli: '.br', zstd: '.zst' } as const;
