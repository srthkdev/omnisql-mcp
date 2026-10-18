# Codex window recording

The MP4 and GIF capture the actual macOS Terminal window running Codex CLI v0.163.0. They show one `omnisql` MCP server comparing the `sales` and `warehouse` connection IDs, inspecting schemas, and querying paid revenue. Both synthetic databases return 740.00 in total; `warehouse.customers` has an extra region column.

macOS captured only the task-owned Terminal window at four frames per second. FFmpeg encoded those window captures; it did not redraw terminal text or invent assistant responses. The model's live tool calls and final table appear as Codex rendered them. The recording is 40 seconds, 1280×740, without audio. Its source is the isolated `.demo/mcp-capture` session and the two synthetic SQLite files in `.demo/instances.json`. Existing database connections are not used.

`mcp-multiple-instances.webp` shows the real `/mcp` view. `mcp-instance-calls.webp` is the final recorded window and also serves as the video poster. Both are lossless WebP: decoded RGBA SHA-256 hashes match their captured PNG inputs exactly. The earlier PNG duplicates, rendered terminal-stream video, and unrelated asciicast were replaced.

The MP4 uses H.264, CRF 24, with fast-start metadata. Its SSIM against the captured source recording is 0.999667. The GIF is a smaller 960-pixel, two-frame-per-second preview; use the video for readable tool details. The README links a static poster so opening the repository does not automatically download and decode the animation.
