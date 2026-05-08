# pi-serve

An ollama-compatible HTTP server extension for the [pi coding agent](https://github.com/mariozechner/pi-coding-agent). Exposes the active pi session as a local API that any ollama-compatible client (Open WebUI, Continue, Aider, etc.) can talk to.

## Install

```bash
pi install npm:pi-serve
```

Or add to your pi `settings.json`:

```json
{
  "packages": ["npm:pi-serve"]
}
```

## Usage

Start pi normally — the server starts automatically on `session_start` and shuts down on `session_shutdown`.

```
[pi-serve] HTTP server listening on http://127.0.0.1:31416
```

The port is **31416** (π × 10 000).

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/` | Status + active model + port |
| `GET` | `/api/version` | Version string |
| `GET` | `/api/tags` | List available models (the active session model) |
| `POST` | `/api/show` | Show active model info |
| `POST` | `/api/generate` | Ollama generate — streaming (NDJSON) or buffered |
| `POST` | `/api/chat` | Ollama chat — streaming (NDJSON) or buffered |
| `POST` | `/v1/chat/completions` | OpenAI-compatible chat completions — SSE or buffered |

## Protocol notes

### Active model

The server always uses the **active pi session model**. The `model` field in incoming requests is ignored. The real model name is reported back in all responses.

### Request queuing

pi processes one conversation turn at a time. Concurrent HTTP requests are serialized: the second request waits until the first `agent_end` event fires before being forwarded to pi.

### Streaming

- Ollama endpoints use NDJSON (one JSON object per line, `Content-Type: application/x-ndjson`).
- OpenAI endpoint uses SSE (`Content-Type: text/event-stream`), terminated by `data: [DONE]`.
- Pass `"stream": false` to receive a single buffered response instead.

## Example

```bash
# Check status
curl http://127.0.0.1:31416/

# Ask a question (streaming)
curl -N http://127.0.0.1:31416/api/generate \
  -H 'Content-Type: application/json' \
  -d '{"prompt": "What is 2+2?"}'

# OpenAI-style chat
curl http://127.0.0.1:31416/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"messages": [{"role": "user", "content": "Hello!"}], "stream": false}'
```

## License

MIT
