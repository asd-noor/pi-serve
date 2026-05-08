import type {
  ExtensionAPI,
  AgentEndEvent,
  SessionStartEvent,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import * as http from "node:http";
import * as crypto from "node:crypto";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PORT = 31416;
const VERSION = "1.1.0";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface QueuedRequest {
  userMessage: string;
  onDelta: (delta: string) => void;
  onEnd: () => void;
  onError: (err: string) => void;
}

// ---------------------------------------------------------------------------
// Module-level state (reset on session_shutdown)
// ---------------------------------------------------------------------------

let activeModel = "unknown";
let availableModels: Array<{ id: string; provider: string }> = [];
let requestQueue: QueuedRequest[] = [];
let isProcessing = false;
let currentRequest: QueuedRequest | null = null;

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
  sendJson(res, 200, { status: "ok", model: activeModel, port: PORT });
}

function handleGetVersion(res: http.ServerResponse): void {
  sendJson(res, 200, { version: VERSION });
}

function handleGetTags(res: http.ServerResponse): void {
  const models = availableModels.length > 0
    ? availableModels.map((m) => ({
        name: `${m.provider}/${m.id}`,
        model: `${m.provider}/${m.id}`,
        modified_at: "2026-01-01T00:00:00Z",
        size: 0,
        digest: "",
        details: { family: m.provider, parameter_size: "unknown" },
      }))
    : [
        {
          name: activeModel,
          model: activeModel,
          modified_at: "2026-01-01T00:00:00Z",
          size: 0,
          digest: "",
          details: { family: activeModel.split("/")[0] ?? "unknown", parameter_size: "unknown" },
        },
      ];
  sendJson(res, 200, { models });
}

function handlePostShow(res: http.ServerResponse): void {
  const parts = activeModel.split("/");
  sendJson(res, 200, {
    model_info: { name: activeModel, provider: parts[0] ?? "unknown" },
  });
}

async function handlePostGenerate(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  enqueue: (r: QueuedRequest) => void
): Promise<void> {
  const raw = await readBody(req);
  const body = parseBodyJson(raw) as Record<string, unknown>;
  const prompt = typeof body.prompt === "string" ? body.prompt : "";
  const stream = body.stream !== false;

  if (!prompt) {
    sendJson(res, 400, { error: "prompt is required" });
    return;
  }

  if (stream) {
    res.writeHead(200, { "Content-Type": "application/x-ndjson" });
    enqueue({
      userMessage: prompt,
      onDelta: (delta) => {
        res.write(JSON.stringify({ model: activeModel, created_at: isoNow(), response: delta, done: false }) + "\n");
      },
      onEnd: () => {
        res.write(JSON.stringify({ model: activeModel, created_at: isoNow(), response: "", done: true, done_reason: "stop" }) + "\n");
        res.end();
      },
      onError: (err) => {
        res.write(JSON.stringify({ error: err, done: true }) + "\n");
        res.end();
      },
    });
  } else {
    const buf: string[] = [];
    enqueue({
      userMessage: prompt,
      onDelta: (delta) => buf.push(delta),
      onEnd: () => sendJson(res, 200, { model: activeModel, created_at: isoNow(), response: buf.join(""), done: true, done_reason: "stop" }),
      onError: (err) => sendJson(res, 500, { error: err }),
    });
  }
}

async function handlePostChat(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  enqueue: (r: QueuedRequest) => void
): Promise<void> {
  const raw = await readBody(req);
  const body = parseBodyJson(raw) as Record<string, unknown>;
  const messages = Array.isArray(body.messages) ? (body.messages as Array<Record<string, unknown>>) : [];
  const stream = body.stream !== false;

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
        res.write(JSON.stringify({ model: activeModel, created_at: isoNow(), message: { role: "assistant", content: delta }, done: false }) + "\n");
      },
      onEnd: () => {
        res.write(JSON.stringify({ model: activeModel, created_at: isoNow(), message: { role: "assistant", content: "" }, done: true, done_reason: "stop" }) + "\n");
        res.end();
      },
      onError: (err) => {
        res.write(JSON.stringify({ error: err, done: true }) + "\n");
        res.end();
      },
    });
  } else {
    const buf: string[] = [];
    enqueue({
      userMessage,
      onDelta: (delta) => buf.push(delta),
      onEnd: () => sendJson(res, 200, { model: activeModel, created_at: isoNow(), message: { role: "assistant", content: buf.join("") }, done: true, done_reason: "stop" }),
      onError: (err) => sendJson(res, 500, { error: err }),
    });
  }
}

async function handleOpenAICompletions(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  enqueue: (r: QueuedRequest) => void
): Promise<void> {
  const raw = await readBody(req);
  const body = parseBodyJson(raw) as Record<string, unknown>;
  const messages = Array.isArray(body.messages) ? (body.messages as Array<Record<string, unknown>>) : [];
  const stream = body.stream === true;
  const completionId = `chatcmpl-${uuid()}`;
  const created = unixNow();

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
          choices: [{ index: 0, delta: { role: "assistant", content: delta }, finish_reason: null }],
        });
        res.write(`data: ${chunk}\n\n`);
      },
      onEnd: () => {
        const final = JSON.stringify({
          id: completionId,
          object: "chat.completion.chunk",
          created,
          model: activeModel,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        });
        res.write(`data: ${final}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
      },
      onError: (err) => {
        res.write(`data: ${JSON.stringify({ error: err })}\n\n`);
        res.end();
      },
    });
  } else {
    const buf: string[] = [];
    enqueue({
      userMessage,
      onDelta: (delta) => buf.push(delta),
      onEnd: () => {
        sendJson(res, 200, {
          id: completionId,
          object: "chat.completion",
          created,
          model: activeModel,
          choices: [{ index: 0, message: { role: "assistant", content: buf.join("") }, finish_reason: "stop" }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        });
      },
      onError: (err) => sendJson(res, 500, { error: { message: err, type: "server_error" } }),
    });
  }
}

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

function createServer(enqueue: (r: QueuedRequest) => void): http.Server {
  return http.createServer((req, res) => {
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
      handlePostGenerate(req, res, enqueue).catch((err) => sendJson(res, 500, { error: String(err) }));
    } else if (method === "POST" && url === "/api/chat") {
      handlePostChat(req, res, enqueue).catch((err) => sendJson(res, 500, { error: String(err) }));
    } else if (method === "POST" && url === "/v1/chat/completions") {
      handleOpenAICompletions(req, res, enqueue).catch((err) => sendJson(res, 500, { error: String(err) }));
    } else {
      sendJson(res, 404, { error: "not found" });
    }
  });
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI): void {
  let server: http.Server | null = null;

  // Queue processing — defined here so it closes over `pi`
  function processNext(): void {
    if (requestQueue.length === 0) {
      isProcessing = false;
      return;
    }
    isProcessing = true;
    currentRequest = requestQueue.shift()!;
    pi.sendUserMessage(currentRequest.userMessage);
  }

  function enqueue(req: QueuedRequest): void {
    requestQueue.push(req);
    if (!isProcessing) processNext();
  }

  // --- Permanent listeners registered once per extension load ---

  pi.on("message_update", (event, _ctx) => {
    if (!currentRequest) return;
    if (event.assistantMessageEvent.type === "text_delta") {
      currentRequest.onDelta(event.assistantMessageEvent.delta);
    }
  });

  pi.on("agent_end", (_event, _ctx) => {
    if (!currentRequest) return;
    const req = currentRequest;
    currentRequest = null;
    req.onEnd();
    processNext();
  });

  pi.on("model_select", (event, _ctx) => {
    activeModel = `${event.model.provider}/${event.model.id}`;
  });

  // --- Session lifecycle ---

  pi.on("session_start", async (_event, ctx) => {
    // Capture active model
    if (ctx.model) {
      activeModel = `${ctx.model.provider}/${ctx.model.id}`;
    }

    // Populate full model list
    try {
      availableModels = await ctx.modelRegistry.getAvailable();
    } catch {
      availableModels = [];
    }

    // Start HTTP server
    server = createServer(enqueue);

    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        console.error(`[pi-serve] port ${PORT} already in use`);
      } else {
        console.error("[pi-serve] server error:", err.message);
      }
    });

    server.listen(PORT, "127.0.0.1", () => {
      console.log(`[pi-serve] listening on http://127.0.0.1:${PORT} (model: ${activeModel})`);
    });
  });

  pi.on("session_shutdown", (_event, _ctx) => {
    // Drain queue
    for (const req of requestQueue) req.onError("session shutting down");
    requestQueue = [];
    isProcessing = false;
    currentRequest = null;

    if (server) {
      server.close();
      server = null;
    }
  });
}
