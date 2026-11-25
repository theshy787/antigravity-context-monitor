import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_URI = "ui://context-token-monitor/dashboard.html";
const BRAIN_DIR = path.join(os.homedir(), ".gemini", "antigravity", "brain");

const dataDirArg = process.argv.find((a) => a.startsWith("--data-dir="));
const DATA_DIR = dataDirArg
  ? dataDirArg.slice("--data-dir=".length)
  : path.join(os.homedir(), ".gemini", "config", "plugin-data", "context-token-monitor");
const SETTINGS_PATH = path.join(DATA_DIR, "settings.json");

const DEFAULT_SETTINGS = {
  planName: "Google AI Pro",
  googleAccount: "",
  contextLimit: 0, // 0 = auto-detect by model (Gemini 1M, Claude/GPT 200K)
  fiveHourTokenBudget: 15000000,
  weeklyTokenBudget: 50000000,
  inputPricePerM: 1.25,
  cachePricePerM: 0.31,
  outputPricePerM: 5.0,
};

function inferModelContextLimit(model, overrideLimit) {
  if (overrideLimit && overrideLimit >= 10000) return overrideLimit;
  const m = String(model || "").toLowerCase();
  if (m.includes("claude") || m.includes("sonnet") || m.includes("opus") || m.includes("haiku")) {
    return 200000;
  }
  if (m.includes("gpt") || m.includes("o1") || m.includes("o3") || m.includes("o4")) {
    return 200000;
  }
  return 1000000;
}

function loadSettings() {
  try {
    const raw = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8"));
    return { ...DEFAULT_SETTINGS, ...raw };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(next) {
  const rawCtx = Number(next.contextLimit);
  const merged = {
    planName: typeof next.planName === "string" && next.planName.trim() ? next.planName.trim() : DEFAULT_SETTINGS.planName,
    googleAccount: typeof next.googleAccount === "string" ? next.googleAccount.trim() : "",
    contextLimit: Number.isFinite(rawCtx) && rawCtx >= 10000 ? rawCtx : 0,
    fiveHourTokenBudget: Math.max(100000, Number(next.fiveHourTokenBudget) || DEFAULT_SETTINGS.fiveHourTokenBudget),
    weeklyTokenBudget: Math.max(500000, Number(next.weeklyTokenBudget) || DEFAULT_SETTINGS.weeklyTokenBudget),
    inputPricePerM: Math.max(0, Number(next.inputPricePerM) ?? DEFAULT_SETTINGS.inputPricePerM),
    cachePricePerM: Math.max(0, Number(next.cachePricePerM) ?? DEFAULT_SETTINGS.cachePricePerM),
    outputPricePerM: Math.max(0, Number(next.outputPricePerM) ?? DEFAULT_SETTINGS.outputPricePerM),
  };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(merged, null, 2), "utf8");
  return merged;
}

function estimateCost(uncachedInputTokens, cacheReadTokens, outputTokens, settings) {
  return (
    (uncachedInputTokens / 1_000_000) * settings.inputPricePerM +
    (cacheReadTokens / 1_000_000) * settings.cachePricePerM +
    (outputTokens / 1_000_000) * settings.outputPricePerM
  );
}

function extractTitle(content) {
  if (!content || typeof content !== "string") return "";
  const match = content.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/);
  const raw = (match ? match[1] : content).replace(/[#>*`\r\n]+/g, " ").trim();
  return raw.slice(0, 64);
}

function parseConversation(convId, transcriptPath, settings) {
  let stat;
  try {
    stat = fs.statSync(transcriptPath);
  } catch {
    return null;
  }

  let text;
  try {
    text = fs.readFileSync(transcriptPath, "utf8");
  } catch {
    return null;
  }

  const lines = text.split("\n");
  let title = "";
  let userTurns = 0;
  let plannerTurns = 0;
  let toolSteps = 0;
  let lastModel = "Unknown";
  let latestInput = 0;
  let latestCacheRead = 0;
  let totalInput = 0;
  let totalCacheRead = 0;
  let totalOutput = 0;
  let thinkingChars = 0;
  let replyChars = 0;
  let prevStepTs = 0;
  let latestTps = 0;
  let latestDurationSec = 0;
  let firstAt = "";
  let lastAt = "";
  const turns = [];
  const dailyMap = new Map();
  const modelMap = new Map();

  for (const line of lines) {
    if (!line.trim()) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }

    const createdAt = obj.created_at || "";
    const currentTs = createdAt ? Date.parse(createdAt) : 0;
    if (createdAt) {
      if (!firstAt) firstAt = createdAt;
      lastAt = createdAt;
    }

    if (obj.type === "USER_INPUT") {
      userTurns += 1;
      if (!title) {
        title = extractTitle(obj.content);
      }
    } else if (obj.type === "PLANNER_RESPONSE") {
      plannerTurns += 1;
      const uncachedInp = Number(obj.input_tokens) || 0;
      const cache = Number(obj.cache_read_tokens) || 0;
      const totalTurnInput = uncachedInp + cache;
      const out = Number(obj.output_tokens) || 0;
      const model = obj.model || lastModel || "Unknown";

      if (typeof obj.thinking === "string") thinkingChars += obj.thinking.length;
      if (typeof obj.content === "string") replyChars += obj.content.length;

      let durationSec = 0;
      let tps = 0;
      if (currentTs > 0 && prevStepTs > 0) {
        const delta = (currentTs - prevStepTs) / 1000;
        if (delta >= 0.3 && delta <= 120 && out > 0) {
          durationSec = Number(delta.toFixed(1));
          tps = Number((out / delta).toFixed(1));
          latestDurationSec = durationSec;
          latestTps = tps;
        }
      }

      if (model !== "Unknown") lastModel = model;
      if (totalTurnInput > 0) {
        latestInput = totalTurnInput;
        latestCacheRead = cache;
      }

      totalInput += totalTurnInput;
      totalCacheRead += cache;
      totalOutput += out;

      turns.push({
        step: obj.step_index ?? plannerTurns,
        at: createdAt,
        model,
        input: totalTurnInput,
        cacheRead: cache,
        output: out,
        durationSec,
        tps,
      });

      const day = createdAt ? createdAt.slice(0, 10) : new Date(stat.mtimeMs).toISOString().slice(0, 10);
      const dayEntry = dailyMap.get(day) || { day, input: 0, cacheRead: 0, output: 0, turns: 0 };
      dayEntry.input += totalTurnInput;
      dayEntry.cacheRead += cache;
      dayEntry.output += out;
      dayEntry.turns += 1;
      dailyMap.set(day, dayEntry);

      const mEntry = modelMap.get(model) || { model, input: 0, cacheRead: 0, output: 0, turns: 0 };
      mEntry.input += totalTurnInput;
      mEntry.cacheRead += cache;
      mEntry.output += out;
      mEntry.turns += 1;
      modelMap.set(model, mEntry);
    } else if (obj.type === "GENERIC" || obj.type === "TOOL_CALL") {
      toolSteps += 1;
    }
    if (currentTs > 0) prevStepTs = currentTs;
  }

  if (plannerTurns === 0 && userTurns === 0) return null;

  const cacheHitRate = totalInput > 0 ? totalCacheRead / totalInput : 0;
  const latestCacheHitRate = latestInput > 0 ? latestCacheRead / latestInput : 0;
  const cost = estimateCost(Math.max(0, totalInput - totalCacheRead), totalCacheRead, totalOutput, settings);
  const effectiveContextLimit = inferModelContextLimit(lastModel, settings.contextLimit);
  const thinkingRatio = thinkingChars + replyChars > 0 ? thinkingChars / (thinkingChars + replyChars) : 0;

  return {
    id: convId,
    title: title || convId.slice(0, 12),
    updatedAt: lastAt || new Date(stat.mtimeMs).toISOString(),
    mtimeMs: stat.mtimeMs,
    model: lastModel,
    effectiveContextLimit,
    userTurns,
    plannerTurns,
    toolSteps,
    latestInput,
    latestCacheRead,
    latestCacheHitRate,
    totalInput,
    totalCacheRead,
    totalOutput,
    cacheHitRate,
    latestTps,
    latestDurationSec,
    thinkingRatio,
    estimatedCost: cost,
    turns: turns.slice(-40),
    allTurns: turns,
    daily: Array.from(dailyMap.values()),
    models: Array.from(modelMap.values()),
  };
}

function collectMetrics(selectedConvId) {
  const settings = loadSettings();
  const conversations = [];

  if (fs.existsSync(BRAIN_DIR)) {
    let entries = [];
    try {
      entries = fs.readdirSync(BRAIN_DIR, { withFileTypes: true });
    } catch {
      entries = [];
    }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const transcriptPath = path.join(BRAIN_DIR, ent.name, ".system_generated", "logs", "transcript.jsonl");
      if (!fs.existsSync(transcriptPath)) continue;
      const parsed = parseConversation(ent.name, transcriptPath, settings);
      if (parsed) conversations.push(parsed);
    }
  }

  conversations.sort((a, b) => b.mtimeMs - a.mtimeMs);

  const dailyTotals = new Map();
  const modelTotals = new Map();
  let grandInput = 0;
  let grandCacheRead = 0;
  let grandOutput = 0;
  const nowMs = Date.now();
  const fiveHoursAgoMs = nowMs - 5 * 3600 * 1000;
  const sevenDaysAgoMs = nowMs - 7 * 24 * 3600 * 1000;
  let fiveHourTotal = 0;
  let fiveHourOutput = 0;
  let fiveHourTurns = 0;
  let weeklyTotal = 0;
  let weeklyOutput = 0;
  let weeklyTurns = 0;

  for (const conv of conversations) {
    grandInput += conv.totalInput;
    grandCacheRead += conv.totalCacheRead;
    grandOutput += conv.totalOutput;

    for (const t of conv.allTurns) {
      const ts = t.at ? Date.parse(t.at) : conv.mtimeMs;
      if (Number.isFinite(ts)) {
        const turnTotal = t.input + t.output;
        if (ts >= fiveHoursAgoMs) {
          fiveHourTotal += turnTotal;
          fiveHourOutput += t.output;
          fiveHourTurns += 1;
        }
        if (ts >= sevenDaysAgoMs) {
          weeklyTotal += turnTotal;
          weeklyOutput += t.output;
          weeklyTurns += 1;
        }
      }
    }

    for (const d of conv.daily) {
      const cur = dailyTotals.get(d.day) || { day: d.day, input: 0, cacheRead: 0, output: 0, turns: 0 };
      cur.input += d.input;
      cur.cacheRead += d.cacheRead;
      cur.output += d.output;
      cur.turns += d.turns;
      dailyTotals.set(d.day, cur);
    }

    for (const m of conv.models) {
      const cur = modelTotals.get(m.model) || { model: m.model, input: 0, cacheRead: 0, output: 0, turns: 0 };
      cur.input += m.input;
      cur.cacheRead += m.cacheRead;
      cur.output += m.output;
      cur.turns += m.turns;
      modelTotals.set(m.model, cur);
    }
  }

  const todayKey = new Date().toISOString().slice(0, 10);
  const todayStats = dailyTotals.get(todayKey) || { day: todayKey, input: 0, cacheRead: 0, output: 0, turns: 0 };

  const dailySeries = Array.from(dailyTotals.values())
    .sort((a, b) => a.day.localeCompare(b.day))
    .slice(-28)
    .map((d) => ({
      ...d,
      estimatedCost: estimateCost(Math.max(0, d.input - d.cacheRead), d.cacheRead, d.output, settings),
    }));

  const modelSeries = Array.from(modelTotals.values())
    .sort((a, b) => b.input + b.output - (a.input + a.output))
    .map((m) => ({
      ...m,
      cacheHitRate: m.input > 0 ? m.cacheRead / m.input : 0,
      estimatedCost: estimateCost(Math.max(0, m.input - m.cacheRead), m.cacheRead, m.output, settings),
    }));

  const active =
    (selectedConvId && conversations.find((c) => c.id === selectedConvId)) ||
    conversations[0] ||
    null;

  return {
    generatedAt: new Date().toISOString(),
    settings,
    summary: {
      conversationCount: conversations.length,
      grandInput,
      grandCacheRead,
      grandOutput,
      grandCacheHitRate: grandInput > 0 ? grandCacheRead / grandInput : 0,
      grandEstimatedCost: estimateCost(Math.max(0, grandInput - grandCacheRead), grandCacheRead, grandOutput, settings),
      todayInput: todayStats.input,
      todayCacheRead: todayStats.cacheRead,
      todayOutput: todayStats.output,
      todayTurns: todayStats.turns,
      todayEstimatedCost: estimateCost(Math.max(0, todayStats.input - todayStats.cacheRead), todayStats.cacheRead, todayStats.output, settings),
      fiveHourTotal,
      fiveHourOutput,
      fiveHourTurns,
      weeklyTotal,
      weeklyOutput,
      weeklyTurns,
    },
    activeConversation: active ? { ...active, allTurns: undefined } : null,
    conversations: conversations.slice(0, 25).map((c) => ({
      id: c.id,
      title: c.title,
      updatedAt: c.updatedAt,
      model: c.model,
      latestInput: c.latestInput,
      totalOutput: c.totalOutput,
      cacheHitRate: c.cacheHitRate,
      plannerTurns: c.plannerTurns,
      estimatedCost: c.estimatedCost,
    })),
    dailySeries,
    modelSeries,
  };
}

function readDashboardHtml() {
  const htmlPath = process.env.MONITOR_APP_HTML || path.join(__dirname, "dist", "dashboard.html");
  return fs.readFileSync(htmlPath, "utf8");
}

const server = new Server(
  { name: "context-token-monitor", version: "1.0.0" },
  { capabilities: { tools: {}, resources: {} } }
);

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [
    {
      uri: APP_URI,
      name: "Token & Context Monitor Dashboard",
      description: "Interactive Antigravity context window and token usage dashboard",
      mimeType: "text/html;profile=mcp-app",
      _meta: { ui: { prefersBorder: false } },
    },
  ],
}));

server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
  if (req.params.uri !== APP_URI) {
    throw new Error(`Unknown resource: ${req.params.uri}`);
  }
  return {
    contents: [
      {
        uri: APP_URI,
        mimeType: "text/html;profile=mcp-app",
        text: readDashboardHtml(),
        _meta: { ui: { prefersBorder: false } },
      },
    ],
  };
});

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "open_token_monitor",
      title: "Token 监控看板",
      description:
        "Open the real-time Antigravity context window, token consumption, cache hit rate, and estimated API cost dashboard.",
      inputSchema: {
        type: "object",
        properties: {
          conversationId: {
            type: "string",
            description: "Optional conversation ID to inspect",
          },
        },
      },
      _meta: {
        ui: { resourceUri: APP_URI },
        "com.google.antigravity/ui": {
          entrypoints: [
            { type: "aux_pane", title: "Token 监控看板" },
            { type: "global", title: "Token 监控看板" },
          ],
        },
      },
    },
    {
      name: "refresh_metrics",
      title: "Refresh token metrics",
      description: "App-only tool to fetch fresh token usage metrics from local transcripts.",
      inputSchema: {
        type: "object",
        properties: {
          conversationId: { type: "string" },
        },
      },
      _meta: {
        ui: { visibility: ["app"] },
      },
    },
    {
      name: "save_budget_settings",
      title: "Save budget settings",
      description: "App-only tool to persist custom context limit, daily token budget, and cost rates.",
      inputSchema: {
        type: "object",
        properties: {
          planName: { type: "string" },
          contextLimit: { type: "number" },
          fiveHourTokenBudget: { type: "number" },
          weeklyTokenBudget: { type: "number" },
          inputPricePerM: { type: "number" },
          cachePricePerM: { type: "number" },
          outputPricePerM: { type: "number" },
          conversationId: { type: "string" },
        },
      },
      _meta: {
        ui: { visibility: ["app"] },
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;

  if (name === "open_token_monitor" || name === "refresh_metrics") {
    const metrics = collectMetrics(typeof args.conversationId === "string" ? args.conversationId : undefined);
    const active = metrics.activeConversation;
    const effLimit = active ? active.effectiveContextLimit : (metrics.settings.contextLimit || 1000000);
    const ctxRemaining = active ? Math.max(0, effLimit - active.latestInput) : effLimit;
    const fiveHRem = Math.max(0, metrics.settings.fiveHourTokenBudget - metrics.summary.fiveHourTotal);
    const weekRem = Math.max(0, metrics.settings.weeklyTokenBudget - metrics.summary.weeklyTotal);
    const summaryText = active
      ? `已加载 Token 监控看板（${metrics.settings.planName} 参考额度）：上下文已用 ${active.latestInput.toLocaleString()} / ${effLimit.toLocaleString()}，剩余 ${ctxRemaining.toLocaleString()} tokens（缓存命中 ${(active.cacheHitRate * 100).toFixed(1)}%）；近 5 小时已用 ${metrics.summary.fiveHourTotal.toLocaleString()}（参考剩余 ${fiveHRem.toLocaleString()}）；近 7 天已用 ${metrics.summary.weeklyTotal.toLocaleString()}（参考剩余 ${weekRem.toLocaleString()}）。`
      : "已加载 Token 监控看板（暂未检测到本地对话日志）。";

    return {
      content: [{ type: "text", text: summaryText }],
      structuredContent: metrics,
    };
  }

  if (name === "save_budget_settings") {
    saveSettings(args);
    const metrics = collectMetrics(typeof args.conversationId === "string" ? args.conversationId : undefined);
    return {
      content: [{ type: "text", text: "预算与上下文上限设置已保存。" }],
      structuredContent: metrics,
    };
  }

  throw new Error(`Unknown tool: ${name}`);
});

const transport = new StdioServerTransport();
await server.connect(transport);
