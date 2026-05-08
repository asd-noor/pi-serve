# pi-serve

An ollama-compatible HTTP server extension for the [pi coding agent](https://github.com/badlogic/pi). Exposes the active pi session as a local API that any ollama-compatible client (Open WebUI, Continue, Aider, etc.) can talk to.

## Install

```bash
pi install git:github.com/asd-noor/pi-serve
```

Or add to `~/.pi/agent/settings.json`:

```json
{
  "packages": ["git:github.com/asd-noor/pi-serve"]
}
```

Then `/reload` in pi.

## Usage

Start pi normally — the server starts automatically on `session_start` and shuts down on `session_shutdown`.

```
[pi-serve] listening on http://127.0.0.1:31416 (model: github-copilot/claude-sonnet-4.6)
```

The port is **31416** (π × 10 000).

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/` | Status — active model and port |
| `GET` | `/api/version` | Version string |
| `GET` | `/api/tags` | List all available models from pi's model registry |
| `POST` | `/api/show` | Active model info |
| `POST` | `/api/generate` | Ollama generate — streaming (NDJSON) or buffered |
| `POST` | `/api/chat` | Ollama chat — streaming (NDJSON) or buffered |
| `POST` | `/v1/chat/completions` | OpenAI-compatible chat completions — SSE or buffered |

## Protocol notes

### Active model

The server always uses the **active pi session model**. The `model` field in incoming requests is ignored. The real model name (e.g. `github-copilot/claude-sonnet-4.6`) is reported back in all responses. Switch models in pi normally (`/model` or Ctrl+P) and the server follows.

### Request queuing

pi processes one conversation turn at a time. Concurrent HTTP requests are serialized — the second request waits until the first `agent_end` event fires before being forwarded to pi.

### Streaming

- Ollama endpoints (`/api/generate`, `/api/chat`) stream NDJSON — one JSON object per line, `Content-Type: application/x-ndjson`.
- OpenAI endpoint (`/v1/chat/completions`) streams SSE — `Content-Type: text/event-stream`, terminated by `data: [DONE]`.
- Pass `"stream": false` to receive a single buffered JSON response instead.

## Examples

```bash
# Health check
curl http://127.0.0.1:31416/

# List models
curl http://127.0.0.1:31416/api/tags

# Generate (streaming)
curl -N http://127.0.0.1:31416/api/generate \
  -H 'Content-Type: application/json' \
  -d '{"prompt": "What is 2+2?"}'

# Chat (buffered)
curl http://127.0.0.1:31416/api/chat \
  -H 'Content-Type: application/json' \
  -d '{"messages": [{"role": "user", "content": "Hello!"}], "stream": false}'

# OpenAI-style (streaming SSE)
curl -N http://127.0.0.1:31416/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"messages": [{"role": "user", "content": "Hello!"}], "stream": true}'
```

## License

[GNU General Public License v3.0](LICENSE)
