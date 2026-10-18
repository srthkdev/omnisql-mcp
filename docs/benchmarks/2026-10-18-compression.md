# Transfer and compression measurements

Measured on 2026-10-18, macOS ARM64, Bun 1.4.3 and Node 24.7.0. Compression levels are gzip 6, Brotli 5 and zstd 3. Each timing is the median of 15 samples after three warmups; every decompressed result is compared byte-for-byte with its input. Samples are synthetic exports, not production workload claims.

## Downloadable exports

| Synthetic CSV, 628,918 bytes | Compressed bytes | Reduction | Bun encode p50 | Bun decode p50 |
| --- | ---: | ---: | ---: | ---: |
| gzip | 98,609 | 84.3% | 2.94 ms | 0.44 ms |
| Brotli | 69,466 | 89.0% | 4.55 ms | 0.57 ms |
| zstd | 90,872 | 85.6% | 0.84 ms | 0.28 ms |

The JSON sample is 1,108,875 bytes: gzip produced 142,734 bytes, Brotli 76,488 and zstd 113,350. Results vary with the data and runtime codec implementation. Raw reports include Node timings too. zstd was the fastest encoder on these inputs; Brotli produced the smallest files. Neither result establishes a universal best codec.

`export_data` accepts an explicit `compression` option. Compressed exports always return a private `read_export` handle, with the original byte count, codec and file format. Readers concatenate decoded base64 chunks and then decompress. Uncompressed exports remain the default so ordinary agent queries and result pages stay readable. Compression has two active slots and eight queued slots, and accepts at most 16 MiB of text. Query/table policies are rechecked on every chunk read. MCP stdio messages retain the standard JSON framing.

## Real screenshots and recording

| Captured PNG | PNG bytes | Lossless WebP bytes | Reduction |
| --- | ---: | ---: | ---: |
| Real `/mcp` window | 84,220 | 20,070 | 76.2% |
| Real two-instance query result | 127,770 | 25,560 | 80.0% |

Decoded RGBA SHA-256 hashes are identical between the captures and shipped WebP files. The hashes are in [the media report](2026-10-18-media.json). The final query screenshot also serves as the video poster, removing a duplicate image. SVG logos remain vectors, and the PNG social card remains compatible with link preview consumers.

A separate codec comparison on the earlier 193,049-byte screenshot produced a 33,740-byte lossless WebP and a 33,916-byte lossless JPEG XL. AVIF at CRF 16 produced 99,736 bytes. A lossless RGB AVIF experiment was larger still and did not preserve the decoded RGBA hash in the tested encoder path. WebP was selected for these text-heavy captures. AVIF/JPEG XL are not shipped just to add formats. Modern image formats still need compatibility choices: [MDN image format guide](https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Formats/Image_types).

The new video captures only the actual Codex Terminal window at 1280×740 and four frames per second. H.264 CRF 24 reduced its captured source from 1,076,705 to 554,973 bytes, with SSIM 0.999667. The recording is 40 seconds. A VP9 experiment was 636,577 bytes with lower SSIM, so the smaller H.264 file is used. The downloadable GIF is a 960-pixel, two-frame-per-second compatibility preview.

The README's initial media is now a 25,560-byte static poster instead of the previous 1,468,814-byte autoplaying GIF, about 98.3% fewer initial media bytes. The GIF remains available by link. The site's video uses `preload="none"`; opening the page does not request the video before playback.

## Website delivery

Bun minifies the existing CSS and browser JavaScript at build time. CSS falls from 28,041 to 21,975 bytes; JavaScript from 7,087 to 4,881. The minified CSS is 5,185 bytes with Node gzip and 4,939 bytes with Brotli at the levels above.

A live request to GitHub Pages on this date, advertising `br, gzip, zstd`, returned the deployed CSS with `Content-Encoding: gzip`, `Vary: Accept-Encoding`, and 5,781 transfer bytes. GitHub Pages controls that negotiation. Unused `.br` or `.zst` siblings would not change its response, so they are not generated. The site gets minified assets and smaller media; it continues to use the CDN's existing compression.

## Rust/WASM experiment

The SQL policy runtime remains unchanged. Binaryen 117 `-Oz --enable-bulk-memory` reduced its raw size from 2,092,859 to 1,915,523 bytes, but increased gzip-9 size from 624,766 to 646,218 bytes. In ten fresh Node samples, median module load plus six first queries rose from 8.87 to 15.03 ms and peak RSS from 84.8 to 186.8 MB. Steady-state parse time improved about 8%, which does not offset the startup and memory regression for this CLI.

`-O1` saved only 5,020 gzip bytes; `-O2` and `-Os` also worsened gzip size and memory. These variants are not shipped. The existing Rust parser still replaces the much larger JavaScript parser dependency; this experiment does not reintroduce it. Smaller raw binaries do not necessarily compress better or initialize faster.

## Reproduce

```sh
bun run build
bun run --cwd docs-site build
bun scripts/benchmark-compression.mjs
node scripts/benchmark-compression.mjs
bun scripts/check-results.mjs
node scripts/check-results.mjs
ffmpeg -i capture.png -frames:v 1 -c:v libwebp -lossless 1 -compression_level 6 capture.webp
cjxl capture.png capture.jxl -d 0 -e 7
```

Raw codec timings: [Bun](2026-10-18-compression-bun.json), [Node](2026-10-18-compression-node.json). [WASM experiment samples](2026-10-18-wasm-optimization.json) record ten alternating before/after Node processes; [other optimizer levels](2026-10-18-wasm-optimization-alternatives.json) record five processes per level. `scripts/benchmark-parser.mjs rust /absolute/path/to/alternate/omnisql_sql_policy.js` tests an alternate module without modifying the shipped runtime.
