import "./style.css";
import { FIELDS, OPERATORS, defaultParams, operandLabel, operandKey, makeContext, formatValue, parseNumber, compact } from "./fields.js";
import { passes } from "./screener.js";
import { store, settings, saveSettings, loadStatic, refreshLive, barsFor, isMarketOpen, avgVol20, lastDate, tradingCalendar, forwardReturn, dayToStr, strToDay } from "./data.js";
import { TEMPLATES, loadScreens, saveScreens, encodeScreen, decodeScreen, loadWatchlist, saveWatchlist } from "./screens.js";
import { ChartPanel } from "./ui/chart.js";

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const F = (f, ...p) => ({ f, p: p.length ? p : defaultParams(f) });

// ---------------------------------------------------------------- cột theo tab
const BT_HORIZONS = [1, 3, 5, 10, 20, "now"];
const TABS = {
  overview: { label: "Tổng quan", cols: [F("price"), F("chg"), F("vol"), F("relVol", 20), F("value"), F("mktcap"), F("pe"), F("eps"), F("divYield")] },
  performance: { label: "Hiệu suất", cols: [F("price"), F("chg"), { f: "perf", p: [5], label: "1 Tuần" }, { f: "perf", p: [21], label: "1 Tháng" }, { f: "perf", p: [63], label: "3 Tháng" }, { f: "perf", p: [126], label: "6 Tháng" }, { f: "perf", p: [250], label: "1 Năm" }, F("fromHigh52")] },
  technical: { label: "Kỹ thuật", cols: [F("price"), F("chg"), F("rsi", 14), F("macdHist"), F("sma", 20), F("sma", 50), F("sma", 200), F("atrPct", 14), F("relVol", 20)] },
  valuation: { label: "Định giá", cols: [F("price"), F("chg"), F("mktcap"), F("pe"), F("eps"), F("divYield"), F("value")] },
  backtest: { label: "Backtest", onlyBacktest: true, cols: [F("price"), F("chg"), F("vol"), ...BT_HORIZONS.map((k) => ({ f: "bt", p: [k], label: k === "now" ? "Đến nay" : `Sau ${k} phiên` }))] },
};

// ---------------------------------------------------------------- trạng thái
const state = {
  screens: loadScreens(),
  screen: null,
  dirty: false,
  tab: localStorage.getItem("vns.tab") || "overview",
  sort: { key: "chg", dir: -1 },
  search: "",
  watchOnly: false,
  watch: loadWatchlist(),
  selected: null,
  rows: [],
  prevSet: null,
  newSince: new Map(),
  prevValues: new Map(),
  loading: true,
  asOf: null, // ngày backtest (số ngày kể từ 1970), null = hôm nay
  tabBeforeBacktest: null,
};

const shared = location.hash.startsWith("#s=") ? decodeScreen(location.hash.slice(3)) : null;
if (shared) {
  state.screen = shared;
  state.dirty = true;
  history.replaceState(null, "", location.pathname);
} else {
  state.screen = structuredClone(state.screens.list[state.screens.current] || state.screens.list[0]);
}
if (!TABS[state.tab] || TABS[state.tab].onlyBacktest) state.tab = "overview";

const chart = new ChartPanel($("#chartPanel"));
chart.onClose = () => selectSymbol(null);

// ---------------------------------------------------------------- bộ lọc (chip)
function filterText(f) {
  const op = OPERATORS[f.op]?.label || f.op;
  if (OPERATORS[f.op]?.unary) return `${operandLabel(f.left)} ${op}`;
  if (f.op === "between") return `${operandLabel(f.left)} ${op} ${operandLabel(f.right)} – ${operandLabel(f.right2 || { v: 0 })}`;
  return `${operandLabel(f.left)} ${op} ${operandLabel(f.right)}`;
}

function renderChips() {
  const el = $("#chips");
  el.innerHTML = state.screen.filters
    .map((f, i) => {
      const [l, ...rest] = filterText(f).split(/ (?=[><≥≤]|cắt|trong|hướng)/);
      return `<span class="chip ${f.off ? "off" : ""}" data-i="${i}"><span class="chip-l">${esc(l)}</span><b>${esc(rest.join(" "))}</b><button class="chip-x" data-x="${i}" title="Xoá">✕</button></span>`;
    })
    .join("");
  document.querySelectorAll("#exchanges button").forEach((b) => b.classList.toggle("on", state.screen.exchanges.includes(b.dataset.ex)));
  $("#watchOnly").classList.toggle("on", state.watchOnly);
  $("#screenName").textContent = state.screen.name;
  $("#dirty").hidden = !state.dirty;
}

$("#chips").onclick = (e) => {
  const x = e.target.closest("[data-x]");
  if (x) {
    state.screen.filters.splice(+x.dataset.x, 1);
    changed();
    return;
  }
  const chip = e.target.closest(".chip");
  if (chip) openEditor(+chip.dataset.i, chip);
};
$("#addFilter").onclick = (e) => openEditor(-1, e.currentTarget);
$("#exchanges").onclick = (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  const ex = state.screen.exchanges;
  const i = ex.indexOf(b.dataset.ex);
  if (i >= 0) { if (ex.length > 1) ex.splice(i, 1); } else ex.push(b.dataset.ex);
  changed();
  poll(true);
};
$("#watchOnly").onclick = () => {
  state.watchOnly = !state.watchOnly;
  renderChips();
  compute();
};

function changed() {
  state.dirty = true;
  state.prevSet = null;
  renderChips();
  compute();
}

// ---------------------------------------------------------------- trình sửa điều kiện
function fieldOptions(selected) {
  const groups = {};
  for (const [k, f] of Object.entries(FIELDS)) (groups[f.group] ||= []).push(`<option value="${k}" ${k === selected ? "selected" : ""}>${esc(f.label)}</option>`);
  return Object.entries(groups).map(([g, o]) => `<optgroup label="${g}">${o.join("")}</optgroup>`).join("");
}
function paramInputs(key, params, side) {
  const defs = FIELDS[key]?.params || [];
  return defs.map((d, i) => `<label class="param">${esc(d.name)}<input type="number" min="1" data-param="${side}" value="${params?.[i] ?? d.def}"></label>`).join("");
}

function openEditor(index, anchor) {
  const isNew = index < 0;
  const f = isNew
    ? { left: F("price"), op: ">", right: F("sma", 20) }
    : structuredClone(state.screen.filters[index]);
  f.right ||= F("sma", 20); // điều kiện một vế (hướng lên/xuống) không có vế phải
  const pop = $("#popover");

  function draw() {
    const rightIsValue = f.right.v !== undefined;
    const unary = !!OPERATORS[f.op]?.unary;
    pop.innerHTML = `
      <div class="ed-row"><select id="edLeft" class="field-sel">${fieldOptions(f.left.f)}</select><span id="edLeftP">${paramInputs(f.left.f, f.left.p, "l")}</span></div>
      <div class="ed-row"><select id="edOp">${Object.entries(OPERATORS).map(([k, o]) => `<option value="${k}" ${k === f.op ? "selected" : ""}>${o.label}</option>`).join("")}</select>
        ${f.op === "between" || unary ? "" : `<div class="seg small" id="edKind"><button data-k="v" class="${rightIsValue ? "on" : ""}">Giá trị</button><button data-k="f" class="${rightIsValue ? "" : "on"}">Chỉ báo</button></div>`}
      </div>
      <div class="ed-row" ${unary ? "hidden" : ""}>${
        f.op === "between"
          ? `<input id="edV" class="num" placeholder="từ" value="${rightIsValue ? esc(fmtIn(f.right)) : ""}"> – <input id="edV2" class="num" placeholder="đến" value="${f.right2 ? esc(fmtIn(f.right2)) : ""}">`
          : rightIsValue
            ? `<input id="edV" class="num" placeholder="vd 5000, 50K, 1T, 0.3" value="${esc(fmtIn(f.right))}">`
            : `<select id="edRight" class="field-sel">${fieldOptions(f.right.f)}</select><span id="edRightP">${paramInputs(f.right.f, f.right.p, "r")}</span>`
      }</div>
      <div class="ed-hint">${hint(f)}</div>
      <div class="ed-actions">
        ${isNew ? "" : `<label class="check"><input type="checkbox" id="edOff" ${f.off ? "checked" : ""}> Tạm tắt</label><button class="btn danger" id="edDel">Xoá</button>`}
        <span class="sp"></span>
        <button class="btn" id="edCancel">Huỷ</button>
        <button class="btn primary" id="edOk">${isNew ? "Thêm" : "Áp dụng"}</button>
      </div>`;
    pop.querySelector("#edLeft").onchange = (e) => { readInputs(); f.left = F(e.target.value); draw(); };
    pop.querySelector("#edOp").onchange = (e) => {
      readInputs();
      f.op = e.target.value;
      if (f.op === "between" && f.right.v === undefined) f.right = { v: 0 };
      if (f.op.startsWith("cross") && f.right.v !== undefined && f.left.f !== "price") f.right = F("sma", 20);
      draw();
    };
    pop.querySelector("#edKind")?.addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      readInputs();
      f.right = b.dataset.k === "v" ? { v: 0 } : F("sma", 20);
      draw();
    });
    pop.querySelector("#edRight")?.addEventListener("change", (e) => { readInputs(); f.right = F(e.target.value); draw(); });
    pop.querySelector("#edCancel").onclick = closePopover;
    pop.querySelector("#edDel")?.addEventListener("click", () => {
      state.screen.filters.splice(index, 1);
      closePopover();
      changed();
    });
    pop.querySelector("#edOk").onclick = () => {
      if (!readInputs(true)) return;
      if (isNew) state.screen.filters.push(f);
      else state.screen.filters[index] = f;
      closePopover();
      changed();
    };
    pop.querySelectorAll("input").forEach((i) => i.addEventListener("keydown", (e) => { if (e.key === "Enter") pop.querySelector("#edOk").click(); }));
  }

  function fmtIn(o) {
    if (o.v === undefined) return "";
    return Math.abs(o.v) >= 1000 ? compact(o.v, 3) : String(o.v);
  }

  function hint(f) {
    const fmt = FIELDS[f.left.f]?.fmt;
    if (OPERATORS[f.op]?.unary) return f.op === "rising" ? "Hướng lên: giá trị phiên hiện tại lớn hơn phiên trước." : "Hướng xuống: giá trị phiên hiện tại nhỏ hơn phiên trước.";
    if (f.op.startsWith("cross")) return "Cắt lên: hôm qua còn ≤, hôm nay đã > (tính trên nến ngày, cập nhật theo giá realtime).";
    if (fmt === "pct") return "Nhập số phần trăm, ví dụ 0.3 nghĩa là 0,3%.";
    if (fmt === "money") return "Đơn vị đồng. Viết tắt: K = nghìn, M = triệu, B = tỷ, T = nghìn tỷ. Ví dụ 1T = 1.000 tỷ.";
    if (fmt === "vol") return "Đơn vị cổ phiếu. Ví dụ 50K = 50.000 cp, 1M = 1 triệu cp.";
    if (fmt === "price") return "Đơn vị đồng, ví dụ 5000 hoặc 5K.";
    return "";
  }

  function readInputs(validate) {
    const lp = [...pop.querySelectorAll('[data-param="l"]')].map((i) => Math.max(1, parseInt(i.value) || 1));
    if (lp.length) f.left.p = lp;
    if (OPERATORS[f.op]?.unary) return true;
    if (f.right.v !== undefined || f.op === "between") {
      const raw = pop.querySelector("#edV")?.value;
      const v = parseNumber(raw);
      if (validate && isNaN(v)) { pop.querySelector("#edV").classList.add("bad"); return false; }
      f.right = { v: isNaN(v) ? 0 : v, ...(FIELDS[f.left.f]?.fmt === "pct" ? { unit: "pct" } : {}) };
      if (f.op === "between") {
        const v2 = parseNumber(pop.querySelector("#edV2")?.value);
        if (validate && isNaN(v2)) { pop.querySelector("#edV2").classList.add("bad"); return false; }
        f.right2 = { v: isNaN(v2) ? 0 : v2, ...(f.right.unit ? { unit: "pct" } : {}) };
      } else delete f.right2;
    } else {
      const rp = [...pop.querySelectorAll('[data-param="r"]')].map((i) => Math.max(1, parseInt(i.value) || 1));
      if (rp.length) f.right.p = rp;
      delete f.right2;
    }
    return true;
  }

  draw();
  pop.hidden = false;
  const r = anchor.getBoundingClientRect();
  const w = Math.min(380, window.innerWidth - 24);
  pop.style.width = w + "px";
  pop.style.left = Math.max(12, Math.min(r.left, window.innerWidth - w - 12)) + "px";
  pop.style.top = r.bottom + window.scrollY + 6 + "px";
  pop.querySelector("#edV")?.focus();
}

function closePopover() {
  $("#popover").hidden = true;
}
document.addEventListener("mousedown", (e) => {
  if (!$("#popover").hidden && !e.target.closest("#popover") && !e.target.closest(".chip") && !e.target.closest("#addFilter") && !e.target.closest("#asOfBtn")) closePopover();
  if (!$("#screenMenu").hidden && !e.target.closest(".screen-menu")) $("#screenMenu").hidden = true;
});

// ---------------------------------------------------------------- menu bộ lọc đã lưu
function renderScreenMenu() {
  const m = $("#screenMenu");
  const list = state.screens.list;
  m.innerHTML = `
    <div class="menu-h">Bộ lọc của tôi</div>
    ${list.map((s, i) => `<button data-open="${i}" class="${i === state.screens.current && !state.dirty ? "on" : ""}">${esc(s.name)}</button>`).join("")}
    <hr>
    <button data-act="saveas">＋ Lưu thành bộ lọc mới…</button>
    <button data-act="rename">✎ Đổi tên…</button>
    ${list.length > 1 ? `<button data-act="delete">🗑 Xoá bộ lọc này</button>` : ""}
    <hr>
    <div class="menu-h">Mẫu có sẵn</div>
    ${TEMPLATES.map((t, i) => `<button data-tpl="${i}">${esc(t.name)}</button>`).join("")}`;
}
$("#screenBtn").onclick = () => {
  renderScreenMenu();
  $("#screenMenu").hidden = !$("#screenMenu").hidden;
};
$("#screenMenu").onclick = (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  $("#screenMenu").hidden = true;
  if (b.dataset.open) {
    state.screens.current = +b.dataset.open;
    state.screen = structuredClone(state.screens.list[state.screens.current]);
    state.dirty = false;
    saveScreens(state.screens);
  } else if (b.dataset.tpl) {
    const t = TEMPLATES[+b.dataset.tpl];
    state.screen = { ...structuredClone(t), exchanges: state.screen.exchanges };
    state.dirty = true;
  } else if (b.dataset.act === "saveas") {
    const name = prompt("Tên bộ lọc mới:", state.screen.name);
    if (!name) return;
    state.screen.name = name;
    state.screens.list.push(structuredClone(state.screen));
    state.screens.current = state.screens.list.length - 1;
    state.dirty = false;
    saveScreens(state.screens);
  } else if (b.dataset.act === "rename") {
    const name = prompt("Tên mới:", state.screen.name);
    if (!name) return;
    state.screen.name = name;
    state.screens.list[state.screens.current].name = name;
    saveScreens(state.screens);
  } else if (b.dataset.act === "delete") {
    if (!confirm(`Xoá bộ lọc "${state.screens.list[state.screens.current].name}"?`)) return;
    state.screens.list.splice(state.screens.current, 1);
    state.screens.current = 0;
    state.screen = structuredClone(state.screens.list[0]);
    state.dirty = false;
    saveScreens(state.screens);
  }
  state.prevSet = null;
  renderChips();
  compute();
  poll(true);
};
$("#saveBtn").onclick = () => {
  if (shared && !state.screens.list.some((s) => s.name === state.screen.name)) {
    state.screens.list.push(structuredClone(state.screen));
    state.screens.current = state.screens.list.length - 1;
  } else {
    state.screens.list[state.screens.current] = structuredClone(state.screen);
  }
  state.dirty = false;
  saveScreens(state.screens);
  renderChips();
  toast("Đã lưu bộ lọc");
};
$("#shareBtn").onclick = async () => {
  const url = location.origin + location.pathname + "#s=" + encodeScreen(state.screen);
  try {
    await navigator.clipboard.writeText(url);
    toast("Đã sao chép link chia sẻ");
  } catch {
    prompt("Sao chép link này:", url);
  }
};

// ---------------------------------------------------------------- tính toán & bảng
function columns() {
  const base = TABS[state.tab].cols;
  const keys = new Set(base.map(operandKey));
  const extra = [];
  for (const f of state.screen.filters) {
    for (const o of OPERATORS[f.op]?.unary ? [f.left] : [f.left, f.right]) {
      if (o.f && !keys.has(operandKey(o))) {
        keys.add(operandKey(o));
        extra.push({ ...o, extra: true });
      }
    }
  }
  return [...base, ...extra];
}

function compute(fromPoll = false) {
  const exs = new Set(state.screen.exchanges);
  const cols = columns();
  const q = state.search.trim().toUpperCase();
  const rows = [];
  const syms = new Set([...Object.keys(store.history), ...Object.keys(store.live)]);
  for (const sym of syms) {
    const meta = store.meta[sym] || {};
    if (meta.e && !exs.has(meta.e)) continue;
    if (state.watchOnly && !state.watch.has(sym)) continue;
    const bars = barsFor(sym, state.asOf);
    if (!bars || bars.c.length < 2) continue;
    const ctx = makeContext(sym, bars, meta);
    if (!passes(ctx, state.screen.filters)) continue;
    if (q && !sym.startsWith(q) && !(meta.n || "").toUpperCase().includes(q)) continue;
    const vals = {};
    for (const c of cols) vals[operandKey(c)] = c.f === "bt" ? (bars.idx != null ? forwardReturn(sym, bars.idx, c.p[0]) : null) : ctx.value(c);
    rows.push({ sym, meta, vals });
  }
  const k = state.sort.key, d = state.sort.dir;
  rows.sort((a, b) => {
    if (k === "sym") return a.sym.localeCompare(b.sym) * d;
    const x = a.vals[k], y = b.vals[k];
    if (x == null) return 1;
    if (y == null) return -1;
    return (x - y) * d;
  });

  // đánh dấu mã mới lọt vào bộ lọc
  const set = new Set(rows.map((r) => r.sym));
  const now = Date.now();
  if (fromPoll && state.asOf == null && state.prevSet && state.screen.filters.length) {
    const fresh = [...set].filter((s) => !state.prevSet.has(s));
    for (const s of fresh) state.newSince.set(s, now);
    if (fresh.length) notifyNew(fresh);
  }
  if (!state.loading && (fromPoll || !state.prevSet)) state.prevSet = set;
  for (const [s, t] of state.newSince) if (now - t > 5 * 60 * 1000 || !set.has(s)) state.newSince.delete(s);

  state.rows = rows;
  renderTable(cols);
  renderBacktestSummary(rows);
}

// ---------------------------------------------------------------- backtest
function renderBacktestSummary(rows) {
  const el = $("#btSummary");
  if (state.asOf == null) { el.hidden = true; return; }
  const cells = BT_HORIZONS.map((k) => {
    const vals = rows.map((r) => forwardReturnFor(r, k)).filter((x) => x != null);
    if (!vals.length) return `<div class="bt-cell"><span>${k === "now" ? "Đến nay" : `Sau ${k} phiên`}</span><b>—</b><small>chưa đủ dữ liệu</small></div>`;
    const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
    const win = (vals.filter((x) => x > 0).length / vals.length) * 100;
    const sorted = [...vals].sort((a, b) => a - b);
    const med = sorted[Math.floor(sorted.length / 2)];
    return `<div class="bt-cell"><span>${k === "now" ? "Đến nay" : `Sau ${k} phiên`}</span>
      <b class="${avg > 0 ? "up" : avg < 0 ? "down" : ""}">${avg > 0 ? "+" : ""}${avg.toFixed(2)}%</b>
      <small>Tỷ lệ tăng ${win.toFixed(0)}% · trung vị ${med > 0 ? "+" : ""}${med.toFixed(2)}% · ${vals.length} mã</small></div>`;
  });
  el.innerHTML = `<div class="bt-head">Backtest: lọc tại phiên <b>${fmtDay(state.asOf)}</b> · ${rows.length} mã thoả điều kiện · lợi nhuận trung bình nếu mua theo giá đóng cửa ngày lọc
    <button class="btn small" id="btExit">Về hôm nay</button></div><div class="bt-grid">${cells.join("")}</div>`;
  el.hidden = false;
  $("#btExit").onclick = () => setAsOf(null);
}

function forwardReturnFor(row, k) {
  const v = row.vals[`bt(${k})`];
  if (v !== undefined) return v;
  const bars = barsFor(row.sym, state.asOf);
  return bars ? forwardReturn(row.sym, bars.idx, k) : null;
}

const fmtDay = (n) => dayToStr(n).split("-").reverse().join("/");

function setAsOf(day) {
  const cal = tradingCalendar();
  if (day != null) {
    // chọn đúng phiên giao dịch gần nhất trước hoặc bằng ngày đã chọn
    const valid = cal.filter((d) => d <= day);
    day = valid.length ? valid[valid.length - 1] : null;
    if (day != null && day >= cal[cal.length - 1]) day = null; // ngày gần nhất = hôm nay
  }
  const was = state.asOf;
  state.asOf = day;
  if (day != null && was == null) {
    state.tabBeforeBacktest = state.tab;
    state.tab = "backtest";
  } else if (day == null && state.tab === "backtest") {
    state.tab = state.tabBeforeBacktest && !TABS[state.tabBeforeBacktest].onlyBacktest ? state.tabBeforeBacktest : "overview";
  }
  state.prevSet = null;
  $("#asOfBtn").textContent = day == null ? "📅 Hôm nay" : "📅 " + fmtDay(day);
  $("#asOfBtn").classList.toggle("on", day != null);
  chart.setAsOf(day == null ? null : dayToStr(day));
  renderTabs();
  compute();
}

$("#asOfBtn").onclick = (e) => {
  const cal = tradingCalendar();
  const pop = $("#popover");
  if (cal.length < 30) {
    toast("Dữ liệu hiện tại chưa có ngày giao dịch. Chờ lần cập nhật dữ liệu tiếp theo.");
    return;
  }
  const last = cal[cal.length - 1];
  const pick = (n) => cal[Math.max(0, cal.length - 1 - n)];
  const quick = [["1 tuần", 5], ["2 tuần", 10], ["1 tháng", 21], ["3 tháng", 63], ["6 tháng", 126]];
  pop.innerHTML = `
    <div class="ed-row"><b>Lọc tại ngày trong quá khứ (backtest)</b></div>
    <div class="ed-row"><input type="date" id="asOfInput" min="${dayToStr(cal[0])}" max="${dayToStr(last)}" value="${dayToStr(state.asOf ?? pick(5))}"></div>
    <div class="ed-row">${quick.map(([l, n]) => `<button class="btn small" data-back="${n}">${l} trước</button>`).join("")}</div>
    <div class="ed-hint">Chỉ báo được tính đúng như tại ngày đó (không dùng dữ liệu tương lai). Bảng sẽ cho biết các mã lọt lọc đã tăng/giảm bao nhiêu sau 1, 3, 5, 10, 20 phiên. Dữ liệu có từ ${fmtDay(cal[0])}; các chỉ báo chu kỳ dài (vd SMA200) cần đủ số phiên trước ngày lọc.</div>
    <div class="ed-actions">
      ${state.asOf != null ? '<button class="btn" id="asOfReset">Về hôm nay</button>' : ""}
      <span class="sp"></span>
      <button class="btn" id="asOfCancel">Huỷ</button>
      <button class="btn primary" id="asOfOk">Lọc</button>
    </div>`;
  pop.querySelectorAll("[data-back]").forEach((b) => (b.onclick = () => { pop.querySelector("#asOfInput").value = dayToStr(pick(+b.dataset.back)); }));
  pop.querySelector("#asOfCancel").onclick = closePopover;
  pop.querySelector("#asOfReset")?.addEventListener("click", () => { closePopover(); setAsOf(null); });
  pop.querySelector("#asOfOk").onclick = () => {
    const v = pop.querySelector("#asOfInput").value;
    closePopover();
    if (v) setAsOf(strToDay(v));
  };
  pop.hidden = false;
  const r = e.currentTarget.getBoundingClientRect();
  const w = Math.min(420, window.innerWidth - 24);
  pop.style.width = w + "px";
  pop.style.left = Math.max(12, Math.min(r.left, window.innerWidth - w - 12)) + "px";
  pop.style.top = r.bottom + window.scrollY + 6 + "px";
};

const LIMITS = { HOSE: 7, HNX: 10, UPCOM: 15 };
function priceClass(chg, ex) {
  if (chg == null) return "";
  const lim = LIMITS[ex] || 7;
  if (chg >= lim * 0.97) return "ceil";
  if (chg <= -lim * 0.97) return "floor";
  if (Math.abs(chg) < 0.005) return "ref";
  return chg > 0 ? "up" : "down";
}

function renderTabs() {
  $("#tabs").innerHTML =
    Object.entries(TABS).filter(([, t]) => !t.onlyBacktest || state.asOf != null).map(([k, t]) => `<button data-tab="${k}" class="${k === state.tab ? "on" : ""}">${t.label}</button>`).join("") +
    `<span class="sp"></span><input id="search" class="search" placeholder="Tìm mã…" value="${esc(state.search)}">`;
  $("#search").oninput = (e) => { state.search = e.target.value; compute(); };
}
$("#tabs").onclick = (e) => {
  const b = e.target.closest("[data-tab]");
  if (!b) return;
  state.tab = b.dataset.tab;
  localStorage.setItem("vns.tab", state.tab);
  renderTabs();
  compute();
};

function renderTable(cols) {
  const head = $("#grid thead");
  const sortIcon = (k) => (state.sort.key === k ? (state.sort.dir < 0 ? " ↓" : " ↑") : "");
  head.innerHTML = `<tr>
    <th class="c-star"></th>
    <th class="c-sym sortable" data-sort="sym">Mã <span class="count">${state.rows.length}</span>${sortIcon("sym")}</th>
    ${cols.map((c) => {
      const k = operandKey(c);
      const label = c.label || operandLabel(c);
      return `<th class="num sortable ${c.extra ? "extra" : ""}" data-sort="${esc(k)}" title="${esc(FIELDS[c.f]?.label || "")}">${esc(label)}${sortIcon(k)}</th>`;
    }).join("")}
  </tr>`;

  const body = $("#grid tbody");
  const prev = state.prevValues;
  const next = new Map();
  const html = [];
  const maxRows = 500;
  for (const r of state.rows.slice(0, maxRows)) {
    const chg = r.vals.chg ?? r.vals[operandKey(F("chg"))];
    const lv = state.asOf == null ? store.live[r.sym] : null;
    const pc = lv?.ce && lv.c >= lv.ce ? "ceil" : lv?.fl && lv.c <= lv.fl ? "floor" : priceClass(chg, r.meta.e);
    const isNew = state.newSince.has(r.sym);
    const cells = cols.map((c) => {
      const k = operandKey(c);
      const v = r.vals[k];
      const f = FIELDS[c.f] || (c.f === "bt" ? { fmt: "pct" } : undefined);
      let cls = "num";
      if (c.f === "price" || c.f === "chg" || c.f === "chgAbs") cls += " " + pc;
      else if (c.f === "bt") cls += " bt" + (v > 0 ? " up" : v < 0 ? " down" : "");
      else if (f?.fmt === "pct" && v != null && !f.unsigned) cls += v > 0 ? " up" : v < 0 ? " down" : "";
      const id = r.sym + "|" + k;
      const old = prev.get(id);
      next.set(id, v);
      if (old != null && v != null && old !== v && (c.f === "price" || c.f === "vol")) cls += v > old || c.f === "vol" ? " flash-up" : " flash-down";
      return `<td class="${cls}">${formatValue(v, f?.fmt, f)}</td>`;
    });
    html.push(`<tr data-sym="${r.sym}" class="${r.sym === state.selected ? "sel" : ""}">
      <td class="c-star"><button class="star ${state.watch.has(r.sym) ? "on" : ""}" data-star="${r.sym}" title="Theo dõi">★</button></td>
      <td class="c-sym"><span class="tk">${r.sym}</span><span class="ex">${esc(r.meta.e || "")}</span>${isNew ? '<span class="new">MỚI</span>' : ""}<span class="nm">${esc(r.meta.n || "")}</span></td>
      ${cells.join("")}</tr>`);
  }
  state.prevValues = next;
  body.innerHTML = html.join("");
  const empty = $("#empty");
  if (state.loading) { empty.hidden = false; empty.textContent = "Đang tải dữ liệu…"; }
  else if (!Object.keys(store.history).length && !Object.keys(store.live).length) {
    empty.hidden = false;
    empty.innerHTML = "Chưa có dữ liệu. Dữ liệu lịch sử được GitHub tự tải mỗi chiều; nếu vừa cài đặt, hãy chờ lần chạy đầu tiên hoàn tất.";
  } else if (!state.rows.length) { empty.hidden = false; empty.textContent = "Không có mã nào thoả tất cả điều kiện."; }
  else if (state.rows.length > maxRows) { empty.hidden = false; empty.textContent = `Hiển thị ${maxRows}/${state.rows.length} mã. Thêm điều kiện để thu hẹp kết quả.`; }
  else empty.hidden = true;
}

$("#grid thead").onclick = (e) => {
  const th = e.target.closest("[data-sort]");
  if (!th) return;
  const k = th.dataset.sort;
  state.sort = state.sort.key === k ? { key: k, dir: -state.sort.dir } : { key: k, dir: k === "sym" ? 1 : -1 };
  compute();
};
$("#grid tbody").onclick = (e) => {
  const star = e.target.closest("[data-star]");
  if (star) {
    const s = star.dataset.star;
    state.watch.has(s) ? state.watch.delete(s) : state.watch.add(s);
    saveWatchlist(state.watch);
    star.classList.toggle("on");
    return;
  }
  const tr = e.target.closest("tr[data-sym]");
  if (tr) selectSymbol(tr.dataset.sym);
};

function selectSymbol(sym) {
  state.selected = sym;
  document.querySelectorAll("#grid tbody tr").forEach((tr) => tr.classList.toggle("sel", tr.dataset.sym === sym));
  const panel = $("#chartPanel");
  document.body.classList.toggle("has-chart", !!sym);
  if (!sym) {
    panel.hidden = true;
    chart.stop();
    return;
  }
  panel.hidden = false;
  chart.show(sym);
}

document.addEventListener("keydown", (e) => {
  if (e.target.closest("input, select, textarea, dialog")) return;
  if (e.key === "Escape") {
    if (!$("#popover").hidden) closePopover();
    else selectSymbol(null);
    return;
  }
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
  if (!state.rows.length) return;
  e.preventDefault();
  let i = state.rows.findIndex((r) => r.sym === state.selected);
  i = e.key === "ArrowDown" ? Math.min(state.rows.length - 1, i + 1) : Math.max(0, i - 1);
  selectSymbol(state.rows[i].sym);
  document.querySelector(`#grid tr[data-sym="${state.rows[i].sym}"]`)?.scrollIntoView({ block: "nearest" });
});

// ---------------------------------------------------------------- cập nhật realtime
let pollTimer = null;
let polling = false;

function universe() {
  const s = settings();
  const exs = new Set(state.screen.exchanges);
  const out = [];
  for (const sym of Object.keys(store.history)) {
    const e = store.meta[sym]?.e;
    if (e && !exs.has(e)) continue;
    if (avgVol20(sym) >= s.minAvgVol || state.watch.has(sym)) out.push(sym);
  }
  if (state.selected && !out.includes(state.selected)) out.push(state.selected);
  return out;
}

async function poll(force) {
  clearTimeout(pollTimer);
  const open = isMarketOpen();
  if ((open || force) && !polling && !document.hidden) {
    polling = true;
    const syms = universe();
    setStatus(`Đang cập nhật ${syms.length} mã…`, "busy");
    const res = await refreshLive(syms, () => {}, state.screen.exchanges);
    polling = false;
    if (!state.polledOnce && res.ok) { state.prevSet = null; state.polledOnce = true; }
    compute(true);
    if (state.selected && !chart.symbol) chart.show(state.selected);
    else if (state.selected) chart.quote();
    updateStatus(res, syms.length);
  } else {
    updateStatus(null, 0);
  }
  pollTimer = setTimeout(() => poll(false), (open ? settings().interval : 60) * 1000);
}

document.addEventListener("visibilitychange", () => { if (!document.hidden && isMarketOpen()) poll(true); });

function updateStatus(res, n) {
  const open = isMarketOpen();
  const t = store.lastLiveAt ? store.lastLiveAt.toLocaleTimeString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" }) : null;
  const s = settings();
  if (store.authError) {
    setStatus("Worker đã khoá", "err");
    showBanner("Worker đã được khoá bằng mật khẩu. Vào ⚙ Cài đặt → nhập \"Mật khẩu Worker\" → Lưu.");
    return;
  }
  if (res && res.ok === 0 && n > 0) {
    setStatus("Không lấy được giá realtime", "err");
    showBanner(s.workerUrl
      ? "Không kết nối được tới Worker hoặc DNSE. Kiểm tra lại địa chỉ Worker trong ⚙ Cài đặt."
      : "Chưa cấu hình Cloudflare Worker nên chưa lấy được giá realtime. Đang hiển thị dữ liệu cuối ngày. Vào ⚙ Cài đặt để nhập địa chỉ Worker.");
    return;
  }
  hideBanner();
  if (open) setStatus(`● Realtime · ${t || "—"} · ${store.source === "SSI" ? res?.ok ?? n : n} mã · ${store.source || ""}`, "live");
  else {
    const anySym = Object.keys(store.live)[0] || Object.keys(store.history)[0];
    const d = anySym ? lastDate(anySym) : null;
    setStatus(`Ngoài giờ giao dịch${d ? " · dữ liệu phiên " + d.split("-").reverse().join("/") : ""}`, "idle");
  }
}

function setStatus(text, kind) {
  const el = $("#status");
  el.textContent = text;
  el.className = "status " + (kind || "");
}
function showBanner(t) { const b = $("#banner"); b.textContent = t; b.hidden = false; }
function hideBanner() { $("#banner").hidden = true; }

function toast(t) {
  const el = $("#toast");
  el.textContent = t;
  el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (el.hidden = true), 2200);
}

function notifyNew(syms) {
  if (!settings().notify || !("Notification" in window) || Notification.permission !== "granted") return;
  new Notification(`${state.screen.name}: ${syms.length} mã mới`, { body: syms.slice(0, 10).join(", ") });
}

// ---------------------------------------------------------------- cài đặt & giao diện
$("#settingsBtn").onclick = () => {
  const s = settings();
  const form = $("#settings form");
  form.workerUrl.value = s.workerUrl;
  form.accessKey.value = s.accessKey;
  form.interval.value = s.interval;
  form.minAvgVol.value = compact(s.minAvgVol, 3);
  form.notify.checked = s.notify;
  $("#settings").showModal();
};
$("#settings").addEventListener("close", async () => {
  if ($("#settings").returnValue !== "ok") return;
  const form = $("#settings form");
  const minAvgVol = parseNumber(form.minAvgVol.value);
  const s = {
    workerUrl: form.workerUrl.value.trim(),
    accessKey: form.accessKey.value.trim(),
    interval: Math.max(5, parseInt(form.interval.value) || 15),
    minAvgVol: isNaN(minAvgVol) ? 10000 : minAvgVol,
    notify: form.notify.checked,
  };
  if (s.notify && "Notification" in window && Notification.permission === "default") await Notification.requestPermission();
  saveSettings(s);
  store.scale = null;
  store.live = {};
  toast("Đã lưu cài đặt");
  poll(true);
});

$("#themeBtn").onclick = () => {
  const cur = document.documentElement.dataset.theme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  const t = cur === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem("vns.theme", t); } catch {}
  chart.refreshTheme();
};

// ---------------------------------------------------------------- khởi động
renderChips();
renderTabs();
renderTable(columns());
loadStatic().then(() => {
  state.loading = false;
  compute();
  poll(true);
});

// Nút Quay lại trên app Android: đóng thứ đang mở, trả về false nếu không còn gì để đóng
window.__vnsBack = () => {
  if (!$("#popover").hidden) { closePopover(); return true; }
  if (!$("#screenMenu").hidden) { $("#screenMenu").hidden = true; return true; }
  if ($("#settings").open) { $("#settings").close(); return true; }
  if (state.selected) { selectSymbol(null); return true; }
  if (state.asOf != null) { setAsOf(null); return true; }
  return false;
};

// Cho phép cài website như app (PWA)
if ("serviceWorker" in navigator && location.protocol === "https:") {
  navigator.serviceWorker.register("./sw.js").catch(() => {});
}
