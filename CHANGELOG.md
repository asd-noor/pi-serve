# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] - 2026-05-08

### Fixed
- Extension never loaded: `package.json` was missing the `"pi"` manifest key, so pi couldn't discover `extension.ts` at the package root
- Listener accumulation: `message_update` and `agent_end` handlers are now registered once at factory load time instead of once per request — no `pi.on()` leak
- Model ID format: now reported as `provider/id` (e.g. `github-copilot/claude-sonnet-4.6`) instead of bare `id`
- Available models for `/api/tags` now populated from `ctx.modelRegistry.getAvailable()` at session start

## [1.0.0] - 2026-05-08

### Added
- Initial release
- HTTP server on port 31416 (π × 10 000), auto-starts on `session_start`
- `GET /` — health check, reports active model and port
- `GET /api/version` — version string
- `GET /api/tags` — lists the active pi session model in ollama format
- `POST /api/show` — active model info
- `POST /api/generate` — ollama generate endpoint, streaming (NDJSON) and buffered
- `POST /api/chat` — ollama chat endpoint, streaming (NDJSON) and buffered
- `POST /v1/chat/completions` — OpenAI-compatible chat completions, SSE streaming and buffered
- Request queue — concurrent HTTP requests are serialized, never dropped
- CORS headers for browser-based clients
- Graceful shutdown — drains queue with errors on `session_shutdown`
