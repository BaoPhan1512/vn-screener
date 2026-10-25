// Gửi tín hiệu lọc cổ phiếu về Telegram (chạy bằng GitHub Actions theo lịch).
// Dùng chung bộ máy lọc với website (web/src/*.js) nên kết quả giống hệt trên web.
//
// Biến môi trường:
//   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID  (GitHub > Settings > Secrets)
//   TELEGRAM_CHAT_ID có thể chứa nhiều id, cách nhau bằng dấu phẩy (vd "111,222,-100333")
//   WORKER_URL                            (Cloudflare Worker lấy giá realtime)
// Tuỳ chọn dòng lệnh:
//   --dry-run   chỉ in tin nhắn ra màn hình, không gửi
//   --force     gửi cả khi hôm nay không có giao dịch (để thử)
//   --data DIR  đọc history.json/meta.json từ thư mục thay vì tải từ website
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OPERATORS, makeContext, operandLabel, formatValue, compact } from "../web/src/fields.js";
import { passes } from "../web/src/screener.js";
import { decodeScreen, encodeScreen } from "../web/src/screens.js";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const DRY = args.includes("--dry-run");
const FORCE = args.includes("--force");
const dataDir = args.includes("--data") ? args[args.indexOf("--data") + 1] : null;

const config = JSON.parse(fs.readFileSync(path.join(ROOT, "alerts.json"), "utf8"));
const SITE = config.siteUrl.replace(/\/?$/, "/");
const WORKER = (process.env.WORKER_URL || config.workerUrl || "").replace(/\/+$/, "");
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHATS = (process.env.TELEGRAM_CHAT_ID || "").split(/[,\s]+/).filter(Boolean);
const VN = 7 * 3600;

const log = (...a) => console.log(...a);
// Dòng "::error::" / "::warning::" hiện ở mục Annotations của lần chạy trên GitHub
const note = (level, msg) => console.log(`::${level}::${String(msg).replace(/\n/g, " ")}`);
const vnDate = (ts) => new Date((ts + VN) * 1000).toISOString().slice(0, 10);
const todayVN = () => vnDate(Math.floor(Date.now() / 1000));
const nowVN = () => new Date(Date.now() + VN * 1000).toISOString().slice(11, 16);

async function getJson(url, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const headers = { "User-Agent": "vn-screener-alert" };
      // Worker đã khoá: gửi kèm mật khẩu (GitHub secret WORKER_KEY)
      if (WORKER && process.env.WORKER_KEY && url.startsWith(WORKER)) headers["X-Access-Key"] = process.env.WORKER_KEY;
      const r = await fetch(url, { headers });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) {
      last = e;
      await new Promise((res) => setTimeout(res, 1500 * (i + 1)));
    }
  }
  throw new Error(`${url}: ${last?.message}`);
}

async function loadStatic() {
  if (dataDir) {
    const read = (f) => JSON.parse(fs.readFileSync(path.join(dataDir, f), "utf8"));
    return { meta: read("meta.json").symbols, history: read("history.json").data };
  }
  const [meta, hist] = await Promise.all([getJson(SITE + "data/meta.json"), getJson(SITE + "data/history.json")]);
  return { meta: meta.symbols, history: hist.data };
}

// Giá trong phiên của toàn bộ mã, qua Worker (45 mã / lần gọi)
async function loadLive(symbols) {
  const raw = {};
  const batches = [];
  for (let i = 0; i < symbols.length; i += 45) batches.push(symbols.slice(i, i + 45));
  let next = 0, failed = 0, lastErr = "";
  async function worker() {
    while (next < batches.length) {
      const b = batches[next++];
      try {
        const d = await getJson(`${WORKER}/snapshot?symbols=${b.join(",")}`);
        Object.assign(raw, d.data || {});
      } catch (e) {
        failed += b.length;
        lastErr = e.message;
        log("lỗi lô:", e.message);
      }
    }
  }
  await Promise.all(Array.from({ length: 4 }, worker));
  // Ghi chú lên mục Annotations của GitHub để dễ biết nguyên nhân
  if (lastErr.includes("401")) note("warning", "Worker từ chối mật khẩu (401): secret WORKER_KEY trên GitHub chưa khớp với ACCESS_KEY của Worker. Đang dùng dữ liệu cuối ngày thay cho giá realtime.");
  else if (failed) note("warning", `Không lấy được giá realtime của ${failed} mã: ${lastErr}`);
  return { raw, failed };
}

function mergeBars(h, lv) {
  const c = h.c.slice(), hi = h.h.slice(), lo = h.l.slice(), v = h.v.slice();
  const o = h.o ? h.o.slice() : new Array(c.length).fill(null);
  if (lv) {
    const d = vnDate(lv.t);
    if (d > h.d) { c.push(lv.c); hi.push(lv.h); lo.push(lv.l); v.push(lv.v); o.push(lv.o); }
    else if (d === h.d) { const i = c.length - 1; c[i] = lv.c; hi[i] = lv.h; lo[i] = lv.l; v[i] = lv.v; o[i] = lv.o; }
  }
  return { c, h: hi, l: lo, v, o };
}

function screenFromConfig(s) {
  if (s.share) {
    const enc = s.share.includes("#s=") ? s.share.split("#s=")[1] : s.share;
    const d = decodeScreen(enc);
    if (!d) throw new Error("Link chia sẻ không hợp lệ: " + s.share.slice(0, 60));
    return { ...d, name: s.name || d.name };
  }
  return { name: s.name, filters: s.filters || [], exchanges: s.exchanges || ["HOSE", "HNX", "UPCOM"] };
}

const esc = (t) => String(t).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);

function filterText(f) {
  const op = OPERATORS[f.op]?.label || f.op;
  if (OPERATORS[f.op]?.unary) return `${operandLabel(f.left)} ${op}`;
  if (f.op === "between") return `${operandLabel(f.left)} ${op} ${operandLabel(f.right)} – ${operandLabel(f.right2 || { v: 0 })}`;
  return `${operandLabel(f.left)} ${op} ${operandLabel(f.right)}`;
}

async function sendTelegram(text) {
  if (DRY || !TOKEN || !CHATS.length) {
    log("----- TIN NHẮN -----\n" + text.replace(/<[^>]+>/g, ""));
    if (!DRY) log("(Chưa cấu hình TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID nên chưa gửi)");
    return;
  }
  // gửi tới từng người nhận; một người lỗi không ảnh hưởng người khác
  const errors = [];
  for (const chat of CHATS) {
    const r = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text, parse_mode: "HTML", disable_web_page_preview: true }),
    });
    const d = await r.json();
    if (!d.ok) errors.push(`chat id ${chat}: ${d.description}${d.error_code === 401 ? " (token bot sai hoặc đã bị thu hồi: kiểm tra secret TELEGRAM_BOT_TOKEN)" : d.error_code === 400 ? " (chat id sai, hoặc tài khoản đó chưa bấm START với bot)" : ""}`);
  }
  if (errors.length) {
    for (const e of errors) note("error", "Telegram: " + e);
    if (errors.length === CHATS.length) throw new Error("Không gửi được tin Telegram nào");
  }
}

async function main() {
  const { meta, history } = await loadStatic();
  const symbols = Object.keys(history);
  log(`Dữ liệu: ${symbols.length} mã`);
  const { raw, failed } = await loadLive(symbols);
  log(`Giá realtime: ${Object.keys(raw).length} mã, lỗi ${failed}`);

  // Đơn vị giá DNSE (nghìn đồng) -> đồng, ước lượng bằng cách so với lịch sử
  const ratios = Object.entries(raw).filter(([s, x]) => x.pc && history[s]).map(([s, x]) => history[s].c.at(-1) / x.pc).sort((a, b) => a - b);
  const k = ratios.length && ratios[Math.floor(ratios.length / 2)] > 100 ? 1000 : 1;
  const live = {};
  let latest = "";
  for (const [s, x] of Object.entries(raw)) {
    if (x.error || x.c == null) continue;
    live[s] = { t: x.t, o: x.o * k, h: x.h * k, l: x.l * k, c: x.c * k, v: x.v || 0 };
    const d = vnDate(x.t);
    if (d > latest) latest = d;
  }
  if (!FORCE && latest !== todayVN()) {
    log(`Hôm nay (${todayVN()}) không có giao dịch (phiên gần nhất ${latest || "?"}), không gửi.`);
    return;
  }

  const maxRows = config.maxRows || 30;
  for (const sc of config.screens) {
    if (sc.enabled === false) continue;
    const screen = screenFromConfig(sc);
    const exs = new Set(screen.exchanges);
    const rows = [];
    for (const sym of symbols) {
      const m = meta[sym] || {};
      if (m.e && !exs.has(m.e)) continue;
      const bars = mergeBars(history[sym], live[sym]);
      if (bars.c.length < 2) continue;
      const ctx = makeContext(sym, bars, m);
      if (!passes(ctx, screen.filters)) continue;
      rows.push({ sym, e: m.e, price: ctx.value({ f: "price" }), chg: ctx.value({ f: "chg" }), vol: ctx.value({ f: "vol" }), value: ctx.value({ f: "value" }) });
    }
    rows.sort((a, b) => (b.chg ?? -1e9) - (a.chg ?? -1e9));
    const link = SITE + "#s=" + encodeScreen(screen);
    const lines = [
      `📊 <b>${esc(screen.name)}</b> · ${nowVN()} ${todayVN().split("-").reverse().join("/")}`,
      `<i>${esc(screen.filters.filter((f) => !f.off).map(filterText).join(" · "))}</i>`,
      "",
      rows.length ? `<b>${rows.length} mã thoả điều kiện</b>${rows.length > maxRows ? ` (hiện ${maxRows} mã tăng mạnh nhất)` : ""}:` : "Không có mã nào thoả điều kiện.",
    ];
    if (rows.length) {
      lines.push("<pre>Mã    Giá       %      KL");
      for (const r of rows.slice(0, maxRows)) {
        const pct = r.chg == null ? "" : (r.chg > 0 ? "+" : "") + r.chg.toFixed(2);
        lines.push(`${r.sym.padEnd(5)} ${formatValue(r.price, "price").padStart(8)} ${pct.padStart(6)} ${compact(r.vol).padStart(7)}`);
      }
      lines.push("</pre>");
    }
    lines.push(`<a href="${esc(link)}">Mở bộ lọc trên website</a>`);
    await sendTelegram(lines.join("\n"));
    log(`Đã xử lý "${screen.name}": ${rows.length} mã`);
  }
}

main().catch((e) => {
  note("error", e.message || e);
  console.error(e);
  process.exit(1);
});
