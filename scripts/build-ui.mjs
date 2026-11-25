import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

const bundled = await build({
  entryPoints: [path.join(rootDir, "src", "ui.ts")],
  bundle: true,
  write: false,
  format: "iife",
  minify: true,
  target: ["es2022"],
});

const jsCode = bundled.outputFiles[0].text;

const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Token &amp; Context Monitor</title>
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--color-background-primary, #11161b);
    color: var(--color-text-primary, #e6edf3);
    font-family: var(--font-sans, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
    font-size: 13px;
    line-height: 1.45;
  }
  .shell { padding: 14px; display: flex; flex-direction: column; gap: 12px; max-width: 1100px; margin: 0 auto; }
  .loading, .empty { padding: 24px; text-align: center; color: var(--color-text-secondary, #8b949e); }
  .topbar { display: flex; justify-content: space-between; align-items: center; gap: 10px; flex-wrap: wrap; }
  .title { font-size: 16px; font-weight: 600; }
  .subtitle, .muted, .kpi-foot { font-size: 11px; color: var(--color-text-secondary, #8b949e); }
  .actions { display: flex; gap: 6px; flex-wrap: wrap; }
  .btn {
    border: 1px solid var(--color-border-primary, #30363d);
    background: var(--color-background-secondary, #161b22);
    color: var(--color-text-primary, #e6edf3);
    padding: 5px 10px;
    border-radius: 6px;
    font-size: 12px;
    cursor: pointer;
  }
  .btn:hover { opacity: 0.9; }
  .btn-active {
    background: var(--color-background-info, #1f6feb);
    border-color: var(--color-border-info, #388bfd);
    color: #fff;
  }
  .card {
    background: var(--color-background-secondary, #161b22);
    border: 1px solid var(--color-border-primary, #30363d);
    border-radius: 10px;
    padding: 12px;
  }
  .card-head { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; flex-wrap: wrap; margin-bottom: 8px; }
  .card-title { font-weight: 600; font-size: 13px; margin-bottom: 8px; }
  .card-head .card-title { margin-bottom: 0; }
  .kpi-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 10px; }
  .kpi-label { font-size: 11px; color: var(--color-text-secondary, #8b949e); margin-bottom: 4px; }
  .kpi-val { font-size: 20px; font-weight: 700; margin-bottom: 6px; }
  .kpi-sub { font-size: 12px; font-weight: 400; color: var(--color-text-secondary, #8b949e); }
  .progress { height: 6px; border-radius: 99px; background: var(--color-background-tertiary, #21262d); overflow: hidden; margin-bottom: 6px; }
  .progress-fill { height: 100%; border-radius: 99px; transition: width 0.25s ease; }
  .progress-fill.good { background: var(--color-text-success, #3fb950); }
  .progress-fill.warning { background: var(--color-text-warning, #d29922); }
  .progress-fill.danger { background: var(--color-text-danger, #f85149); }
  .chart-svg { width: 100%; height: 140px; display: block; }
  .bar-input { fill: #58a6ff; opacity: 0.78; }
  .bar-cache { fill: #3fb950; opacity: 0.92; }
  .chart-label { fill: var(--color-text-secondary, #8b949e); font-size: 10px; }
  .legend { display: flex; gap: 14px; font-size: 11px; color: var(--color-text-secondary, #8b949e); margin-top: 4px; }
  .dot { display: inline-block; width: 8px; height: 8px; border-radius: 2px; margin-right: 4px; vertical-align: middle; }
  .dot-input { background: #58a6ff; }
  .dot-cache { background: #3fb950; }
  .two-col { display: grid; grid-template-columns: repeat(auto-fit, minmax(290px, 1fr)); gap: 10px; }
  .daily-grid { display: flex; align-items: flex-end; gap: 6px; height: 120px; padding-top: 8px; }
  .daily-col { flex: 1; display: flex; flex-direction: column; align-items: center; height: 100%; gap: 4px; }
  .daily-bar-wrap { flex: 1; width: 100%; display: flex; align-items: flex-end; justify-content: center; }
  .daily-bar { width: 70%; max-width: 24px; background: #58a6ff; border-radius: 4px 4px 0 0; min-height: 3px; }
  .daily-day { font-size: 10px; color: var(--color-text-secondary, #8b949e); }
  .heatmap-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 5px; }
  .hm-cell { height: 24px; border-radius: 5px; display: flex; align-items: center; justify-content: center; font-size: 10px; color: rgba(255,255,255,0.75); }
  .hm-l0 { background: var(--color-background-tertiary, #21262d); color: var(--color-text-secondary, #8b949e); }
  .hm-l1 { background: #0e4429; }
  .hm-l2 { background: #006d32; }
  .hm-l3 { background: #26a641; }
  .hm-l4 { background: #39d353; color: #0b1117; font-weight: 600; }
  .tbl { width: 100%; border-collapse: collapse; font-size: 12px; }
  .tbl th, .tbl td { text-align: left; padding: 6px 4px; border-bottom: 1px solid var(--color-border-primary, #30363d); }
  .tbl th { font-size: 11px; color: var(--color-text-secondary, #8b949e); font-weight: 500; }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; }
  .conv-list { display: flex; flex-direction: column; gap: 6px; max-height: 240px; overflow-y: auto; }
  .conv-item {
    display: flex; flex-direction: column; align-items: flex-start; gap: 2px;
    width: 100%; text-align: left; padding: 8px 10px; border-radius: 8px;
    border: 1px solid var(--color-border-primary, #30363d);
    background: var(--color-background-primary, #11161b);
    color: var(--color-text-primary, #e6edf3);
    cursor: pointer;
  }
  .conv-item.conv-active { border-color: #58a6ff; background: rgba(88, 166, 255, 0.12); }
  .conv-title { font-weight: 500; font-size: 12px; }
  .conv-meta { font-size: 11px; color: var(--color-text-secondary, #8b949e); }
  .form-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 8px; margin-bottom: 10px; }
  .form-grid label { display: flex; flex-direction: column; gap: 4px; font-size: 11px; color: var(--color-text-secondary, #8b949e); }
  .form-grid input {
    background: var(--color-background-primary, #11161b);
    color: var(--color-text-primary, #e6edf3);
    border: 1px solid var(--color-border-primary, #30363d);
    border-radius: 6px; padding: 5px 8px; font-size: 12px;
  }
  .form-actions { display: flex; justify-content: flex-end; }
</style>
</head>
<body>
  <div id="root"><div class="loading">正在初始化 Token 监控看板…</div></div>
  <script>${jsCode}</script>
</body>
</html>`;

fs.mkdirSync(path.join(rootDir, "dist"), { recursive: true });
fs.writeFileSync(path.join(rootDir, "dist", "dashboard.html"), html, "utf8");
console.log("Built dist/dashboard.html:", Buffer.byteLength(html, "utf8"), "bytes");
