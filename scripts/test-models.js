#!/usr/bin/env node
//
// Cross-model regression sweep. Hits every model in the discovered list with
// three canned scenarios via the same Databricks AI Gateway endpoints Mason
// uses. Catches model-family compatibility regressions before they ship.
//
// Usage:
//   npm run test:models                           # all models
//   npm run test:models -- --filter claude        # subset
//   npm run test:models -- --profile prod         # different profile
//
// Reads profile from ~/.databrickscfg, mints OAuth via the local databricks
// CLI, discovers models via /api/2.0/serving-endpoints, sends each scenario.

"use strict";

const { execSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  applyAnthropicCaching,
  consolidateSystemMessages,
  maxTokensFor,
  supportsStreamOptions,
} = require("../build/ts/chat-shared");

// ---------- args ----------
function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  if (i === -1) return fallback;
  return process.argv[i + 1] ?? fallback;
}
const PROFILE = arg("--profile", "DEFAULT");
const FILTER = arg("--filter", "");
const TIMEOUT_MS = 30_000;

// ---------- profile + token ----------
function parseHost(profileName) {
  const cfgPath = path.join(os.homedir(), ".databrickscfg");
  if (!fs.existsSync(cfgPath)) die(`~/.databrickscfg not found`);
  const text = fs.readFileSync(cfgPath, "utf-8");
  let inSection = false;
  for (const line of text.split("\n")) {
    const sec = line.match(/^\[(.+)\]$/);
    if (sec) {
      inSection = sec[1] === profileName;
      continue;
    }
    if (!inSection) continue;
    const kv = line.match(/^host\s*=\s*(.+)$/);
    if (kv) return kv[1].trim().replace(/\/+$/, "");
  }
  die(`Profile [${profileName}] has no host in ~/.databrickscfg`);
}

function mintToken(profileName) {
  try {
    const out = execSync(`databricks auth token --profile ${profileName}`, {
      encoding: "utf-8",
      timeout: 10_000,
    }).trim();
    return JSON.parse(out).access_token;
  } catch (e) {
    die(`Failed to mint OAuth token for [${profileName}]: ${e.message}`);
  }
}

// ---------- discovery ----------
async function discoverModels(host, token) {
  const res = await fetchWithTimeout(`${host}/api/2.0/serving-endpoints`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) die(`Model discovery failed: HTTP ${res.status}`);
  const data = await res.json();
  return (data.endpoints || [])
    .filter(
      (e) =>
        e.endpoint_type === "FOUNDATION_MODEL_API" &&
        e.task &&
        e.task.includes("chat") &&
        e.state?.ready === "READY"
    )
    .map((e) => {
      const fm = e.config?.served_entities?.[0]?.foundation_model || {};
      const apiTypes = fm.api_types || [];
      const supportsChat = apiTypes.includes("mlflow/v1/chat/completions");
      const supportsResponses = apiTypes.includes("openai/v1/responses");
      let format = null;
      if (supportsChat) format = "chat";
      else if (supportsResponses) format = "responses";
      return format ? { value: e.name, format, apiTypes } : null;
    })
    .filter(Boolean);
}

// ---------- scenarios ----------
const STUB_TOOL = {
  type: "function",
  function: {
    name: "echo",
    description: "Echo back a message. Used only for regression testing.",
    parameters: {
      type: "object",
      properties: { message: { type: "string" } },
      required: ["message"],
    },
  },
};

const SCENARIOS = [
  {
    name: "hello-no-tools",
    build: () => ({
      messages: [{ role: "user", content: "Reply with the single word: hello" }],
      tools: null,
    }),
  },
  {
    name: "hello-with-tools",
    build: () => ({
      messages: [{ role: "user", content: "Reply with the single word: hello" }],
      tools: [STUB_TOOL],
    }),
  },
  {
    name: "multi-system",
    build: () => ({
      messages: [
        { role: "system", content: "You are a helpful assistant." },
        { role: "system", content: "Reply concisely." },
        { role: "system", content: "Skills available: none. Do not invoke load_skill." },
        { role: "user", content: "Reply with the single word: hello" },
      ],
      tools: null,
    }),
  },
];

// ---------- request builder (mirrors main.ts chat handler) ----------
function buildBody(model, scenario, format) {
  const { messages, tools } = scenario.build();
  const isResponses = format === "responses";
  // Skip Responses for sweep — its message shape differs and the bugs we're
  // guarding against are chat-completions specific.
  if (isResponses) return null;
  // Mirror Mason's chatLoop: when tools are present AND the model supports
  // Responses, the renderer promotes to Responses (works around GPT-5.5's
  // server-side reasoning_effort injection that conflicts with tools in
  // chat completions). Since the sweep only exercises chat-completions, skip
  // tool scenarios on these models — they'd 400 in this path but Mason never
  // sends them this way.
  const supportsResponses = (model.apiTypes || []).includes("openai/v1/responses");
  if (supportsResponses && tools && tools.length > 0) return null;

  let body = {
    model: model.value,
    max_tokens: maxTokensFor(model.value),
    messages: messages.slice(),
  };
  if (tools && tools.length > 0) {
    body.tools = tools;
    body.tool_choice = "auto";
  }
  body.stream = true;
  if (supportsStreamOptions(model.value)) {
    body.stream_options = { include_usage: true };
  }
  body.messages = consolidateSystemMessages(body.messages);
  applyAnthropicCaching(body, model.value);
  return body;
}

// ---------- runner ----------
async function runOne(host, token, model, scenario) {
  const body = buildBody(model, scenario, model.format);
  if (!body) {
    const reason =
      model.format === "responses"
        ? "responses-only"
        : "promotes-to-responses-with-tools";
    return { model: model.value, scenario: scenario.name, ok: true, skip: reason };
  }
  const url = `${host}/ai-gateway/mlflow/v1/chat/completions`;
  try {
    const res = await fetchWithTimeout(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      return {
        model: model.value,
        scenario: scenario.name,
        ok: false,
        error: `HTTP ${res.status}: ${text.slice(0, 200)}`,
      };
    }
    // Drain the stream so the test is realistic. We don't render anything;
    // just confirm the stream completes without an error frame.
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      // Look for an obvious error in the stream
      if (buf.includes('"error"')) {
        return {
          model: model.value,
          scenario: scenario.name,
          ok: false,
          error: `Stream contained error: ${buf.slice(0, 200)}`,
        };
      }
    }
    return { model: model.value, scenario: scenario.name, ok: true };
  } catch (e) {
    return {
      model: model.value,
      scenario: scenario.name,
      ok: false,
      error: e.message,
    };
  }
}

// ---------- output ----------
function printReport(results) {
  const byModel = new Map();
  for (const r of results) {
    if (!byModel.has(r.model)) byModel.set(r.model, []);
    byModel.get(r.model).push(r);
  }
  let totalOk = 0;
  let totalFail = 0;
  for (const [model, rs] of byModel) {
    const allOk = rs.every((r) => r.ok);
    const symbol = allOk ? "✓" : "✗";
    console.log(`${symbol} ${model}`);
    for (const r of rs) {
      if (r.skip) {
        console.log(`    · ${r.scenario.padEnd(20)} skipped (${r.skip})`);
      } else if (r.ok) {
        totalOk++;
        console.log(`    ✓ ${r.scenario}`);
      } else {
        totalFail++;
        console.log(`    ✗ ${r.scenario.padEnd(20)} ${r.error}`);
      }
    }
  }
  console.log("");
  console.log(`Total: ${totalOk} passed, ${totalFail} failed`);
}

function fetchWithTimeout(url, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  return fetch(url, { ...opts, signal: ctrl.signal }).finally(() =>
    clearTimeout(t)
  );
}

function die(msg) {
  console.error(`ERROR: ${msg}`);
  process.exit(2);
}

// ---------- main ----------
async function main() {
  console.log(`Profile: ${PROFILE}`);
  const host = parseHost(PROFILE);
  console.log(`Host:    ${host}`);
  const token = mintToken(PROFILE);
  console.log(`Discovering models...`);
  const models = await discoverModels(host, token);
  const targets = FILTER
    ? models.filter((m) => m.value.toLowerCase().includes(FILTER.toLowerCase()))
    : models;
  console.log(`Testing ${targets.length} model(s) × ${SCENARIOS.length} scenario(s)...\n`);

  const results = [];
  for (const m of targets) {
    for (const s of SCENARIOS) {
      const r = await runOne(host, token, m, s);
      results.push(r);
    }
  }

  printReport(results);
  process.exit(results.some((r) => !r.ok && !r.skip) ? 1 : 0);
}

main().catch((e) => die(e.stack || e.message));
