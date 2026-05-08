import type { ExtensionAPI, ExtensionContext, AgentEndEvent } from "@mariozechner/pi-coding-agent";
import * as http from "node:http";
import * as crypto from "node:crypto";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PORT = 31416;
const VERSION = "0.1.0";

// ---------------------------------------------------------------------------
// Request queue types
// ---------------------------------------------------------------------------

interface QueuedRequest {
  userMessage: string;
  onDelta: (delta: string) => void;
  onEnd: () => void;
  onError: (err: string) => void;
}

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

let activeModel = "unknown";
let requestQueue: QueuedRequest[] = [];
let isProcessing = false;
let piApi: ExtensionAPI | null = null;

// Subscribed listener unsubscribe functions for the current in-flight request
let unsubMessageUpdate: (() => void) | null = null;
let unsubAgentEnd: (() => void) | null = null;

// ---------------------------------------------------------------------------
// Queue helpers
// ---------------------------------------------------------------------------

function processNext(): void {
  if (requestQueue.length === 0) {
    isProcessing = false;
    return;
  }
  isProcessing = true;
  const req = requestQueue.shift()!;

  // Unsubscribe any stale listeners (safety guard)
  unsubMessageUpdate?.();
  unsubAgentEnd?.();
  unsubMessageUpdate = null;
  unsubAgentEnd = null;

  if (!piApi) {
    req.onError("pi API not available");
    processNext();
    return;
  }

  // Register one-shot listeners
  const onUpdate = (event: { assistantMessageEvent: { type: string; delta?: string } }, _ctx: ExtensionContext) => {
    if (
      event.assistantMessageEvent.type === "text_delta" &&
      event.assistantMessageEvent.delta
    ) {
      req.onDelta(event.assistantMessageEvent.delta);
    }
  };

  const onEnd = (_event: AgentEndEvent, _ctx: ExtensionContext) => {
    // Tear down listeners
    unsubMessageUpdate?.();
    unsubAgentEnd?.();
    unsubMessageUpdate = null;
    unsubAgentEnd = null;
    req.onEnd();
    // Process next item in queue
    processNext();
  };

  // pi.on returns void but the runner uses the registered handlers array;
  // we capture them for manual removal via wrapper arrays.
  // pi doesn't expose an "off" yet — use a closed-over flag to make them
  // effectively one-shot.
  let done = false;

  const guardedUpdate = (event: { assistantMessageEvent: { type: string; delta?: string } }, ctx: ExtensionContext) => {
    if (!done) onUpdate(event, ctx);
  };
  const guardedEnd = (event: AgentEndEvent, ctx: ExtensionContext) => {
    if (done) return;
    done = true;
    onEnd(event, ctx);
  };

  // Store no-ops as "unsubscribe" — since pi has no off(), we rely on the
  // done flag to ignore subsequent firings after the request completes.
  unsubMessageUpdate = () => { done = true; };
  unsubAgentEnd = () => { done = true; };

  piApi.on("message_update", guardedUpdate);
  piApi.on("agent_end", guardedEnd);

  piApi.sendUserMessage(req.userMessage);
}

function enqueue(req: QueuedRequest): void {
  requestQueue.push(req);
  if (!isProcessing) processNext();
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function isoNow(): string {
  return new Date().toISOString();
}

function unixNow(): number {
  return Math.floor(Date.now() / 1000);
}

function uuid(): string {
  return crypto.randomUUID();
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(data),
  });
  res.end(data);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function parseBodyJson(raw: string): unknown {
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

function handleGetRoot(res: http.ServerResponse): void {
  sendJson(res, 200, {
    status: "ok",
    model: activeModel,
    port: PORT,
  });
}

function handleGetVersion(res: http.ServerResponse): void {
  sendJson(res, 200, { version: VERSION });
}

function handleGetTags(res: http.ServerResponse): void {
  sendJson(res, 200, {
    models: [
      {
        name: activeModel,
        model: activeModel,
        modified_at: "2026-01-01T00:00:00Z",
        size: 0,
        digest: "",
        details: {
          family: activeModel.split("/")[0] ?? "unknown",
          parameter_size: "unknown",
        },
      },
    ],
  });
}

function handlePostShow(res: http.ServerResponse): void {
  const parts = activeModel.split("/");
  sendJson(res, 200, {
    model_info: {
      name: activeModel,
      provider: parts[0] ?? "unknown",
    },
  });
}

// POST /api/generate
async function handlePostGenerate(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  const raw = await readBody(req);
  const body = parseBodyJson(raw) as Record<string, unknown>;
  const prompt = typeof body.prompt === "string" ? body.prompt : "";
  const stream = body.stream !== false; // default true

  if (!prompt) {
    sendJson(res, 400, { error: "prompt is required" });
    return;
  }

  if (stream) {
    res.writeHead(200, { "Content-Type": "application/x-ndjson" });

    enqueue({
      userMessage: prompt,
      onDelta: (delta) => {
        const chunk = JSON.stringify({
          model: activeModel,
          created_at: isoNow(),
          response: delta,
          done: false,
        });
        res.write(chunk + "\n");
      },
      onEnd: () => {
        const final = JSON.stringify({
          model: activeModel,
          created_at: isoNow(),
          response: "",
          done: true,
          done_reason: "stop",
        });
        res.write(final + "\n");
        res.end();
      },
      onError: (err) => {
        const errChunk = JSON.stringify({ error: err, done: true });
        res.write(errChunk + "\n");
        res.end();
      },
    });
  } else {
    // Non-streaming: buffer all deltas
    const buffers: string[] = [];

    enqueue({
      userMessage: prompt,
      onDelta: (delta) => buffers.push(delta),
      onEnd: () => {
        sendJson(res, 200, {
          model: activeModel,
          created_at: isoNow(),
          response: buffers.join(""),
          done: true,
          done_reason: "stop",
        });
      },
      onError: (err) => {
        sendJson(res, 500, { error: err });
      },
    });
  }
}

// POST /api/chat
async function handlePostChat(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  const raw = await readBody(req);
  const body = parseBodyJson(raw) as Record<string, unknown>;
  const messages = Array.isArray(body.messages) ? body.messages as Array<Record<string, unknown>> : [];
  const stream = body.stream !== false; // default true

  // Extract last user message
  let userMessage = "";
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      const content = messages[i].content;
      userMessage = typeof content === "string" ? content : "";
      break;
    }
  }

  if (!userMessage) {
    sendJson(res, 400, { error: "no user message found" });
    return;
  }

  if (stream) {
    res.writeHead(200, { "Content-Type": "application/x-ndjson" });

    enqueue({
      userMessage,
      onDelta: (delta) => {
        const chunk = JSON.stringify({
          model: activeModel,
          created_at: isoNow(),
          message: { role: "assistant", content: delta },
          done: false,
        });
        res.write(chunk + "\n");
      },
      onEnd: () => {
        const final = JSON.stringify({
          model: activeModel,
          created_at: isoNow(),
          message: { role: "assistant", content: "" },
          done: true,
          done_reason: "stop",
        });
        res.write(final + "\n");
        res.end();
      },
      onError: (err) => {
        const errChunk = JSON.stringify({ error: err, done: true });
        res.write(errChunk + "\n");
        res.end();
      },
    });
  } else {
    const buffers: string[] = [];

    enqueue({
      userMessage,
      onDelta: (delta) => buffers.push(delta),
      onEnd: () => {
        sendJson(res, 200, {
          model: activeModel,
          created_at: isoNow(),
          message: { role: "assistant", content: buffers.join("") },
          done: true,
          done_reason: "stop",
        });
      },
      onError: (err) => {
        sendJson(res, 500, { error: err });
      },
    });
  }
}

// POST /v1/chat/completions  (OpenAI-compatible)
async function handleOpenAICompletions(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  const raw = await readBody(req);
  const body = parseBodyJson(raw) as Record<string, unknown>;
  const messages = Array.isArray(body.messages) ? body.messages as Array<Record<string, unknown>> : [];
  const stream = body.stream === true; // default false for OpenAI compat
  const completionId = `chatcmpl-${uuid()}`;
  const created = unixNow();

  // Extract last user message
  let userMessage = "";
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      const content = messages[i].content;
      userMessage = typeof content === "string" ? content : "";
      break;
    }
  }

  if (!userMessage) {
    sendJson(res, 400, { error: { message: "no user message found", type: "invalid_request_error" } });
    return;
  }

  if (stream) {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });

    enqueue({
      userMessage,
      onDelta: (delta) => {
        const chunk = JSON.stringify({
          id: completionId,
          object: "chat.completion.chunk",
          created,
          model: activeModel,
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content: delta },
              finish_reason: null,
            },
          ],
        });
        res.write(`data: ${chunk}\n\n`);
      },
      onEnd: () => {
        const finalChunk = JSON.stringify({
          id: completionId,
          object: "chat.completion.chunk",
          created,
          model: activeModel,
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: "stop",
            },
          ],
        });
        res.write(`data: ${finalChunk}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
      },
      onError: (err) => {
        res.write(`data: ${JSON.stringify({ error: err })}\n\n`);
        res.end();
      },
    });
  } else {
    const buffers: string[] = [];

    enqueue({
      userMessage,
      onDelta: (delta) => buffers.push(delta),
      onEnd: () => {
        const content = buffers.join("");
        sendJson(res, 200, {
          id: completionId,
          object: "chat.completion",
          created,
          model: activeModel,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content },
              finish_reason: "stop",
            },
          ],
          usage: {
            prompt_tokens: 0,
            completion_tokens: 0,
            total_tokens: 0,
          },
        });
      },
      onError: (err) => {
        sendJson(res, 500, { error: { message: err, type: "server_error" } });
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Server setup
// ---------------------------------------------------------------------------

function createServer(): http.Server {
  const server = http.createServer(
    (req: http.IncomingMessage, res: http.ServerResponse) => {
      // CORS headers for browser clients
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }

      const url = req.url ?? "/";
      const method = req.method ?? "GET";

      if (method === "GET" && url === "/") {
        handleGetRoot(res);
      } else if (method === "GET" && url === "/api/version") {
        handleGetVersion(res);
      } else if (method === "GET" && url === "/api/tags") {
        handleGetTags(res);
      } else if (method === "POST" && url === "/api/show") {
        handlePostShow(res);
      } else if (method === "POST" && url === "/api/generate") {
        handlePostGenerate(req, res).catch((err: unknown) => {
          sendJson(res, 500, { error: String(err) });
        });
      } else if (method === "POST" && url === "/api/chat") {
        handlePostChat(req, res).catch((err: unknown) => {
          sendJson(res, 500, { error: String(err) });
        });
      } else if (method === "POST" && url === "/v1/chat/completions") {
        handleOpenAICompletions(req, res).catch((err: unknown) => {
          sendJson(res, 500, { error: String(err) });
        });
      } else {
        sendJson(res, 404, { error: "not found" });
      }
    }
  );

  return server;
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI): void {
  let server: http.Server | null = null;

  pi.on("session_start", async (_event, ctx) => {
    piApi = pi;

    // Resolve active model from context
    if (ctx.model) {
      activeModel = ctx.model.id;
    }

    // Start HTTP server
    server = createServer();
    server.listen(PORT, "127.0.0.1", () => {
      console.log(`[pi-serve] HTTP server listening on http://127.0.0.1:${PORT}`);
    });

    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        console.error(`[pi-serve] Port ${PORT} already in use — server not started`);
      } else {
        console.error("[pi-serve] Server error:", err);
      }
    });
  });

  pi.on("model_select", (event: { model: { id: string } }) => {
    activeModel = event.model.id;
  });

  pi.on("session_shutdown", () => {
    piApi = null;

    // Drain queue with errors
    for (const req of requestQueue) {
      req.onError("session shutting down");
    }
    requestQueue = [];
    isProcessing = false;

    if (server) {
      server.close();
      server = null;
    }
  });
}
