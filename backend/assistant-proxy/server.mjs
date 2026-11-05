import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { runAgentTurn } from "./agent.mjs";
import { acceptPlan, readModelContent } from "./validate.mjs";

const systemPrompt = `Translate one user sentence into JSON.
Use only these intents: open_app, open_website, search_web, set_reminder, list_reminders, cancel_reminder, change_companion_visuals, open_system_settings, explain_screen, guide_task, press_control, general_question, unsupported.
Use mode execute, guide, explain, or answer.
Return an object with intent, mode, parameters, missingRequiredFields, and requiresScreenContext.
To point at a control, use guide_task with parameters.name and an optional parameters.role.
To press a control, use press_control with parameters.name and an optional parameters.role.
Do not return a shell command, a script, a tool name, or x, y, or coordinates.`;

export function startProxy(options = {}) {
  const key = options.apiKey ?? process.env.ASSISTANT_API_KEY ?? "";
  const upstream =
    options.upstreamUrl ??
    process.env.ASSISTANT_UPSTREAM_URL ??
    "https://api.openai.com/v1/chat/completions";
  const model = options.model ?? process.env.ASSISTANT_MODEL ?? "gpt-4o-mini";
  const agentModel =
    "agentModel" in options ? (options.agentModel ?? "") : (process.env.COMPANION_AGENT_MODEL ?? "");
  const token = options.token ?? process.env.COMPANION_PROXY_TOKEN ?? "";
  const fetchImpl = options.fetch ?? fetch;
  const stamps = new Map();

  const server = createServer(async (request, response) => {
    const path = request.url ?? "";
    if (request.method !== "POST" || (path !== "/v1/interpret" && path !== "/v1/agent/turn")) {
      send(response, 404, { error: "not_found" });
      return;
    }
    if (token && request.headers.authorization !== `Bearer ${token}`) {
      send(response, 401, { error: "unauthorized" });
      return;
    }
    const ip = request.socket.remoteAddress ?? "local";
    const now = options.now?.() ?? Date.now();
    if (!allow(stamps, ip, options.maxPerMinute ?? 30, now)) {
      send(response, 429, { error: "rate_limited" });
      return;
    }
    if (path === "/v1/agent/turn") {
      await handleAgent(request, response, { ...options, apiKey: key, model: agentModel });
      return;
    }
    await handleInterpret(request, response, {
      key,
      upstream,
      model,
      fetchImpl,
      timeoutMs: options.timeoutMs ?? 12_000,
    });
  });

  return {
    server,
    listen(port = 0) {
      return new Promise((resolve) => {
        server.listen(port, "127.0.0.1", () => resolve(server.address()));
      });
    },
    close() {
      return new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

async function handleInterpret(request, response, options) {
  const raw = await readBody(request, 4_000);
  if (raw === null) {
    send(response, 413, { error: "too_large" });
    return;
  }
  let text = "";
  try {
    const body = JSON.parse(raw);
    if (
      typeof body.text !== "string" ||
      !body.text.trim() ||
      "screenshot" in body ||
      "audio" in body
    ) {
      send(response, 400, { error: "bad_request" });
      return;
    }
    text = body.text.trim();
  } catch {
    send(response, 400, { error: "bad_request" });
    return;
  }
  if (!options.key) {
    send(response, 503, { error: "unconfigured" });
    return;
  }
  try {
    const upstreamResponse = await options.fetchImpl(options.upstream, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${options.key}`,
      },
      body: JSON.stringify({
        model: options.model,
        temperature: 0,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: text },
        ],
      }),
      signal: AbortSignal.timeout(options.timeoutMs),
    });
    const payload = await upstreamResponse.json();
    const plan = acceptPlan(readModelContent(payload));
    if (!upstreamResponse.ok || !plan) {
      send(response, 422, { error: "rejected" });
      return;
    }
    send(response, 200, { request: plan });
  } catch {
    send(response, 504, { error: "timeout" });
  }
}

async function handleAgent(request, response, options) {
  const raw = await readBody(request, 256_000);
  if (raw === null) {
    send(response, 413, { error: "too_large" });
    return;
  }
  const disconnected = new AbortController();
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 20_000);
  const onGone = () => {
    if (!response.writableEnded) {
      disconnected.abort();
    }
  };
  response.on("close", onGone);
  const signal = AbortSignal.any([timeout, disconnected.signal]);
  try {
    const result = await runAgentTurn(raw, {
      apiKey: options.apiKey,
      model: options.model,
      responses: options.responses,
      signal,
    });
    if (!response.destroyed) {
      send(response, result.status, result.body);
    }
  } finally {
    response.off("close", onGone);
  }
}

function allow(stamps, ip, max, now) {
  const recent = (stamps.get(ip) ?? []).filter((stamp) => stamp > now - 60_000);
  if (recent.length >= max) {
    stamps.set(ip, recent);
    return false;
  }
  recent.push(now);
  stamps.set(ip, recent);
  return true;
}

function readBody(request, max) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > max) {
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", () => resolve(null));
  });
}

function send(response, status, body) {
  const encoded = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json" });
  response.end(encoded);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const proxy = startProxy();
  const port = Number(process.env.PORT ?? 8787);
  await proxy.listen(port);
  console.log(`assistant proxy listening on 127.0.0.1:${port}`);
}
