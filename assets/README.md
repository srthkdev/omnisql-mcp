# Codex session recording

`codex-session.mp4` and its GIF preview capture a real Codex CLI v0.163.0 session using the `omnisql-demo` MCP server. The prompt asks Codex to list connections, inspect the customers table, and query paid revenue per customer. Codex also inspects orders before running its query.

The session uses the synthetic SQLite fixtures created by `npm run demo`. The MCP process has read-only access and an allowlist containing only `sales` and `sales-v2`. No personal database connections or credentials appear in the recording.

`codex-session.cast` contains the timestamped terminal output in asciicast v2 format. The video was made by capturing that terminal stream at two frames per second, displaying it in Menlo, and encoding the frames with FFmpeg. The assistant text, tool calls, results, and their order come from the live session. It is a terminal recording, not the Codex desktop app.

The poster is the final captured frame. The earlier illustrated walkthrough and installer animation have been removed.
