import {
  App,
  applyDocumentTheme,
  applyHostStyleVariables,
} from "@modelcontextprotocol/ext-apps";

type Settings = {
  planName: string;
  contextLimit: number;
  fiveHourTokenBudget: number;
  weeklyTokenBudget: number;
  inputPricePerM: number;
  cachePricePerM: number;
  outputPricePerM: number;
};

type Turn = {
  step: number;
  at: string;
  model: string;
  input: number;
  cacheRead: number;
  output: number;
  durationSec?: number;
  tps?: number;
};

type ConversationSummary = {
  id: string;
  title: string;
  updatedAt: string;
  model: string;
  latestInput: number;
  totalOutput: number;
  cacheHitRate: number;
  plannerTurns: number;
  estimatedCost: number;
};

type ActiveConversation = ConversationSummary & {
  effectiveContextLimit: number;
  userTurns: number;
  toolSteps: number;
  latestCacheRead: number;
  latestCacheHitRate: number;
  totalInput: number;
  totalCacheRead: number;
  latestTps?: number;
  latestDurationSec?: number;
  thinkingRatio?: number;
  turns: Turn[];
};

type MetricsPayload = {
  generatedAt: string;
  settings: Settings;
  summary: {
    conversationCount: number;
    grandInput: number;
    grandCacheRead: number;
    grandOutput: number;
    grandCacheHitRate: number;
    grandEstimatedCost: number;
    todayInput: number;
    todayCacheRead: number;
    todayOutput: number;
    todayTurns: number;
    todayEstimatedCost: number;
    fiveHourTotal: number;
    fiveHourOutput: number;
    fiveHourTurns: number;
    weeklyTotal: number;
    weeklyOutput: number;
    weeklyTurns: number;
  };
  activeConversation: ActiveConversation | null;
  conversations: ConversationSummary[];
  dailySeries: Array<{
    day: string;
    input: number;
    cacheRead: number;
    output: number;
    turns: number;
    estimatedCost: number;
  }>;
  modelSeries: Array<{
    model: string;
    input: number;
    cacheRead: number;
    output: number;
    turns: number;
    cacheHitRate: number;
    estimatedCost: number;
  }>;
};

const app = new App({ name: "Token & Context Monitor", version: "1.0.0" }, {});
let currentData: MetricsPayload | null = null;
let selectedConvId: string | undefined;
let autoRefresh = true;
let settingsOpen = false;
let refreshTimer: number | null = null;
let isFetching = false;

const root = document.getElementById("root")!;

function fmtNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(Math.round(n));
}

function fmtPct(ratio: number): string {
  return `${(Math.max(0, Math.min(1, ratio)) * 100).toFixed(1)}%`;
}

function fmtUsd(v: number): string {
  return `$${v.toFixed(3)}`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderTurnsChart(turns: Turn[], contextLimit: number): string {
  if (!turns.length) {
    return `<div class="empty">当前会话暂无模型响应轮次</div>`;
  }
  const w = 640;
  const h = 140;
  const padL = 8;
  const padR = 8;
  const padT = 14;
  const padB = 22;
  const maxVal = Math.max(...turns.map((t) => t.input), 1000);
  const innerW = w - padL - padR;
  const innerH = h - padT - padB;
  const barW = Math.max(4, Math.min(20, innerW / turns.length - 3));
  const stepX = innerW / turns.length;

  const bars = turns
    .map((t, i) => {
      const totalH = (t.input / maxVal) * innerH;
      const cacheH = (Math.min(t.cacheRead, t.input) / maxVal) * innerH;
      const x = padL + i * stepX + (stepX - barW) / 2;
      const y = padT + (innerH - totalH);
      const cy = padT + (innerH - cacheH);
      const pct = ((t.input / contextLimit) * 100).toFixed(1);
      return `
        <g>
          <title>Step #${t.step} (${t.model})\n输入上下文: ${t.input.toLocaleString()} (${pct}%)\n缓存命中: ${t.cacheRead.toLocaleString()}\n输出: ${t.output.toLocaleString()}</title>
          <rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(2, totalH).toFixed(1)}" rx="2" class="bar-input" />
          <rect x="${x.toFixed(1)}" y="${cy.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(0, cacheH).toFixed(1)}" rx="2" class="bar-cache" />
        </g>`;
    })
    .join("");

  return `
    <svg viewBox="0 0 ${w} ${h}" class="chart-svg" preserveAspectRatio="none">
      ${bars}
      <text x="${padL}" y="${h - 5}" class="chart-label">首轮</text>
      <text x="${w - padR}" y="${h - 5}" text-anchor="end" class="chart-label">最新轮次（峰值 ${fmtNum(maxVal)}）</text>
    </svg>
    <div class="legend">
      <span><i class="dot dot-input"></i>新增输入</span>
      <span><i class="dot dot-cache"></i>Prompt 缓存命中</span>
    </div>`;
}

function renderDailyHeatmap(daily: MetricsPayload["dailySeries"]): string {
  const byDay = new Map(daily.map((d) => [d.day, d]));
  const days: Array<{ day: string; total: number; cost: number; turns: number }> = [];
  const now = new Date();
  for (let i = 27; i >= 0; i--) {
    const dt = new Date(now.getTime() - i * 86400_000);
    const key = dt.toISOString().slice(0, 10);
    const hit = byDay.get(key);
    days.push({
      day: key,
      total: hit ? hit.input + hit.output : 0,
      cost: hit ? hit.estimatedCost : 0,
      turns: hit ? hit.turns : 0,
    });
  }
  const maxVal = Math.max(...days.map((d) => d.total), 1);
  return `
    <div class="heatmap-grid">
      ${days
        .map((d) => {
          const ratio = d.total / maxVal;
          const level = d.total === 0 ? 0 : ratio < 0.25 ? 1 : ratio < 0.5 ? 2 : ratio < 0.75 ? 3 : 4;
          return `<div class="hm-cell hm-l${level}" title="${d.day}\n总 Token: ${d.total.toLocaleString()}\n轮次: ${d.turns} | 参考费: ${fmtUsd(d.cost)}"><span>${d.day.slice(8)}</span></div>`;
        })
        .join("")}
    </div>
    <div class="legend" style="margin-top:6px">
      <span>近 28 天活跃热力图（低 → 高）</span>
      <span><i class="dot hm-l0"></i><i class="dot hm-l1"></i><i class="dot hm-l2"></i><i class="dot hm-l3"></i><i class="dot hm-l4"></i></span>
    </div>`;
}

function render(data: MetricsPayload) {
  currentData = data;
  const active = data.activeConversation;
  const s = data.settings;
  const ctxUsed = active?.latestInput ?? 0;
  const effectiveLimit = active?.effectiveContextLimit ?? (s.contextLimit || 1000000);
  const ctxRemaining = Math.max(0, effectiveLimit - ctxUsed);
  const ctxRatio = effectiveLimit > 0 ? ctxUsed / effectiveLimit : 0;
  const ctxRemainingRatio = Math.max(0, 1 - ctxRatio);
  const ctxTone = ctxRatio >= 0.85 ? "danger" : ctxRatio >= 0.65 ? "warning" : "good";

  const fiveHUsed = data.summary.fiveHourTotal;
  const fiveHRem = Math.max(0, s.fiveHourTokenBudget - fiveHUsed);
  const fiveHOver = Math.max(0, fiveHUsed - s.fiveHourTokenBudget);
  const fiveHRatio = s.fiveHourTokenBudget > 0 ? fiveHUsed / s.fiveHourTokenBudget : 0;
  const fiveHTone = fiveHRatio >= 0.9 ? "danger" : fiveHRatio >= 0.7 ? "warning" : "good";

  const weekUsed = data.summary.weeklyTotal;
  const weekRem = Math.max(0, s.weeklyTokenBudget - weekUsed);
  const weekOver = Math.max(0, weekUsed - s.weeklyTokenBudget);
  const weekRatio = s.weeklyTokenBudget > 0 ? weekUsed / s.weeklyTokenBudget : 0;
  const weekTone = weekRatio >= 0.9 ? "danger" : weekRatio >= 0.7 ? "warning" : "good";

  const updatedTime = new Date(data.generatedAt).toLocaleTimeString();

  root.innerHTML = `
    <div class="shell">
      <header class="topbar">
        <div>
          <div class="title">Token &amp; 上下文监控看板</div>
          <div class="subtitle">只读解析本地 transcript.jsonl · 更新于 ${escapeHtml(updatedTime)}</div>
        </div>
        <div class="actions">
          <button id="btn-refresh" class="btn">刷新</button>
          <button id="btn-auto" class="btn ${autoRefresh ? "btn-active" : ""}">${autoRefresh ? "自动刷新: 5s" : "自动刷新: 关"}</button>
          <button id="btn-settings" class="btn ${settingsOpen ? "btn-active" : ""}">预算设置</button>
        </div>
      </header>

      ${
        settingsOpen
          ? `<section class="card settings-card">
              <div class="card-head">
                <div class="card-title">额度预设与预算设置（当前：${escapeHtml(s.planName)}）</div>
                <div class="actions">
                  <button id="preset-pro" class="btn">Google AI Pro 预设</button>
                  <button id="preset-ultra" class="btn">Google AI Ultra 预设</button>
                </div>
              </div>
              <div class="subtitle" style="margin-bottom:8px">Google AI Pro 采用动态 5 小时滚动 + 7 天周限额（未公开固定 Token 常数），此处为本地参考预算，可按实测微调；官方精确余量请以客户端 /quota 为准。</div>
              <div class="form-grid">
                <label>方案名称<input id="in-plan" type="text" value="${escapeHtml(s.planName)}" /></label>
                <label>上下文上限（0=按模型自动）<input id="in-ctx" type="number" value="${s.contextLimit}" /></label>
                <label>5 小时参考预算<input id="in-5h" type="number" value="${s.fiveHourTokenBudget}" /></label>
                <label>7 天周参考预算<input id="in-week" type="number" value="${s.weeklyTokenBudget}" /></label>
                <label>输入单价 ($/M)<input id="in-inprice" type="number" step="0.01" value="${s.inputPricePerM}" /></label>
                <label>缓存单价 ($/M)<input id="in-cprice" type="number" step="0.01" value="${s.cachePricePerM}" /></label>
                <label>输出单价 ($/M)<input id="in-outprice" type="number" step="0.01" value="${s.outputPricePerM}" /></label>
              </div>
              <div class="form-actions">
                <button id="btn-save-settings" class="btn btn-active">保存设置</button>
              </div>
            </section>`
          : ""
      }

      <section class="kpi-grid">
        <div class="card kpi" title="已用: ${ctxUsed.toLocaleString()} tokens&#10;剩余: ${ctxRemaining.toLocaleString()} tokens&#10;上限: ${effectiveLimit.toLocaleString()} tokens">
          <div class="kpi-label">当前上下文 · 剩余 Token</div>
          <div class="kpi-val">${fmtNum(ctxRemaining)} <span class="kpi-sub">剩余 (${fmtPct(ctxRemainingRatio)})</span></div>
          <div class="progress"><div class="progress-fill ${ctxTone}" style="width:${Math.min(100, ctxRatio * 100).toFixed(1)}%"></div></div>
          <div class="kpi-foot">已用 ${fmtNum(ctxUsed)} / ${fmtNum(effectiveLimit)} (${fmtPct(ctxRatio)}) · ${escapeHtml(active?.model || "-")}</div>
        </div>

        <div class="card kpi" title="近 5 小时已用: ${fiveHUsed.toLocaleString()} tokens&#10;参考剩余: ${fiveHRem.toLocaleString()} tokens&#10;5 小时参考预算: ${s.fiveHourTokenBudget.toLocaleString()} tokens">
          <div class="kpi-label">${escapeHtml(s.planName)} · 5 小时窗口剩余</div>
          <div class="kpi-val">${fiveHOver > 0 ? `超参考 +${fmtNum(fiveHOver)}` : fmtNum(fiveHRem)} <span class="kpi-sub">${fiveHOver > 0 ? "" : `剩余 (${fmtPct(1 - fiveHRatio)})`}</span></div>
          <div class="progress"><div class="progress-fill ${fiveHTone}" style="width:${Math.min(100, fiveHRatio * 100).toFixed(1)}%"></div></div>
          <div class="kpi-foot">近 5h 已用 ${fmtNum(fiveHUsed)} / ${fmtNum(s.fiveHourTokenBudget)} · ${data.summary.fiveHourTurns} 轮</div>
        </div>

        <div class="card kpi" title="近 7 天已用: ${weekUsed.toLocaleString()} tokens&#10;参考剩余: ${weekRem.toLocaleString()} tokens&#10;7 天参考预算: ${s.weeklyTokenBudget.toLocaleString()} tokens">
          <div class="kpi-label">${escapeHtml(s.planName)} · 7 天周额度剩余</div>
          <div class="kpi-val">${weekOver > 0 ? `超参考 +${fmtNum(weekOver)}` : fmtNum(weekRem)} <span class="kpi-sub">${weekOver > 0 ? "" : `剩余 (${fmtPct(1 - weekRatio)})`}</span></div>
          <div class="progress"><div class="progress-fill ${weekTone}" style="width:${Math.min(100, weekRatio * 100).toFixed(1)}%"></div></div>
          <div class="kpi-foot">近 7 天已用 ${fmtNum(weekUsed)} / ${fmtNum(s.weeklyTokenBudget)} · ${data.summary.weeklyTurns} 轮</div>
        </div>

        <div class="card kpi">
          <div class="kpi-label">缓存命中 · 生成速度</div>
          <div class="kpi-val">${fmtPct(active?.cacheHitRate ?? data.summary.grandCacheHitRate)} <span class="kpi-sub">${active?.latestTps ? `${active.latestTps} tok/s` : ""}</span></div>
          <div class="kpi-foot">思考占比 ${fmtPct(active?.thinkingRatio ?? 0)} · 今日参考费 ${fmtUsd(data.summary.todayEstimatedCost)}</div>
        </div>
      </section>

      <section class="card">
        <div class="card-head">
          <div class="card-title">当前会话每轮上下文增长：${escapeHtml(active?.title || "暂无会话")}</div>
          <div class="muted">${active ? `${active.userTurns} 提问 · ${active.plannerTurns} 回复 · ${active.toolSteps} 工具步骤 · 输出 ${fmtNum(active.totalOutput)}` : ""}</div>
        </div>
        ${renderTurnsChart(active?.turns || [], effectiveLimit)}
      </section>

      <div class="two-col">
        <section class="card">
          <div class="card-title">近 28 天 Token 活跃热力图</div>
          ${renderDailyHeatmap(data.dailySeries)}
        </section>

        <section class="card">
          <div class="card-title">按模型分布</div>
          ${
            data.modelSeries.length
              ? `<table class="tbl">
                  <thead><tr><th>模型</th><th>轮次</th><th>缓存率</th><th>总 Token</th><th>参考费</th></tr></thead>
                  <tbody>
                    ${data.modelSeries
                      .map(
                        (m) => `<tr>
                          <td class="mono">${escapeHtml(m.model)}</td>
                          <td>${m.turns}</td>
                          <td>${fmtPct(m.cacheHitRate)}</td>
                          <td>${fmtNum(m.input + m.output)}</td>
                          <td>${fmtUsd(m.estimatedCost)}</td>
                        </tr>`
                      )
                      .join("")}
                  </tbody>
                </table>`
              : `<div class="empty">暂无模型统计</div>`
          }
        </section>
      </div>

      <section class="card">
        <div class="card-title">最近会话（点击切换查看详情）</div>
        <div class="conv-list">
          ${data.conversations
            .map(
              (c) => `
              <button class="conv-item ${active && c.id === active.id ? "conv-active" : ""}" data-conv="${escapeHtml(c.id)}">
                <span class="conv-title">${escapeHtml(c.title)}</span>
                <span class="conv-meta">${escapeHtml(c.model)} · 上下文 ${fmtNum(c.latestInput)} · 输出 ${fmtNum(c.totalOutput)} · ${c.plannerTurns} 轮</span>
              </button>`
            )
            .join("")}
        </div>
      </section>
    </div>
  `;

  document.getElementById("btn-refresh")?.addEventListener("click", () => fetchFresh());
  document.getElementById("btn-auto")?.addEventListener("click", () => {
    autoRefresh = !autoRefresh;
    syncTimer();
    if (currentData) render(currentData);
  });
  document.getElementById("btn-settings")?.addEventListener("click", () => {
    settingsOpen = !settingsOpen;
    if (currentData) render(currentData);
  });
  document.getElementById("preset-pro")?.addEventListener("click", () => {
    (document.getElementById("in-plan") as HTMLInputElement).value = "Google AI Pro";
    (document.getElementById("in-ctx") as HTMLInputElement).value = "1000000";
    (document.getElementById("in-5h") as HTMLInputElement).value = "15000000";
    (document.getElementById("in-week") as HTMLInputElement).value = "50000000";
  });
  document.getElementById("preset-ultra")?.addEventListener("click", () => {
    (document.getElementById("in-plan") as HTMLInputElement).value = "Google AI Ultra";
    (document.getElementById("in-ctx") as HTMLInputElement).value = "1000000";
    (document.getElementById("in-5h") as HTMLInputElement).value = "60000000";
    (document.getElementById("in-week") as HTMLInputElement).value = "200000000";
  });
  document.getElementById("btn-save-settings")?.addEventListener("click", async () => {
    const val = (id: string) => Number((document.getElementById(id) as HTMLInputElement)?.value);
    const planName = (document.getElementById("in-plan") as HTMLInputElement)?.value || "Google AI Pro";
    const res = await app.callServerTool({
      name: "save_budget_settings",
      arguments: {
        planName,
        contextLimit: val("in-ctx"),
        fiveHourTokenBudget: val("in-5h"),
        weeklyTokenBudget: val("in-week"),
        inputPricePerM: val("in-inprice"),
        cachePricePerM: val("in-cprice"),
        outputPricePerM: val("in-outprice"),
        conversationId: selectedConvId,
      },
    });
    settingsOpen = false;
    if (res.structuredContent) {
      render(res.structuredContent as unknown as MetricsPayload);
    }
  });

  document.querySelectorAll<HTMLButtonElement>(".conv-item").forEach((btn) => {
    btn.addEventListener("click", () => {
      selectedConvId = btn.dataset.conv;
      fetchFresh();
    });
  });
}

async function fetchFresh() {
  if (isFetching) return;
  isFetching = true;
  try {
    const res = await app.callServerTool({
      name: "refresh_metrics",
      arguments: selectedConvId ? { conversationId: selectedConvId } : {},
    });
    if (res.structuredContent) {
      render(res.structuredContent as unknown as MetricsPayload);
    }
  } catch {
    // Ignore transient abort when panel closes
  } finally {
    isFetching = false;
  }
}

function syncTimer() {
  if (refreshTimer !== null) {
    window.clearInterval(refreshTimer);
    refreshTimer = null;
  }
  if (autoRefresh) {
    refreshTimer = window.setInterval(() => {
      if (!settingsOpen) fetchFresh();
    }, 5000);
  }
}

// Register handlers BEFORE connect() per MCP Apps spec
app.ontoolinput = () => {
  if (!currentData) {
    root.innerHTML = `<div class="loading">正在读取本地对话 Token 日志…</div>`;
  }
};

app.ontoolresult = (result) => {
  if (result.structuredContent) {
    const payload = result.structuredContent as unknown as MetricsPayload;
    if (!selectedConvId && payload.activeConversation) {
      selectedConvId = payload.activeConversation.id;
    }
    render(payload);
    syncTimer();
  }
};

app.onhostcontextchanged = (ctx) => {
  if (ctx.theme) applyDocumentTheme(ctx.theme);
  if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
};

async function boot() {
  await app.connect();
  const ctx = app.getHostContext();
  if (ctx?.theme) applyDocumentTheme(ctx.theme);
  if (ctx?.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
}

boot();
