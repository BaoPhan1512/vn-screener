// Tải dữ liệu: lịch sử (file tĩnh do GitHub Actions tạo) + giá trong phiên (DNSE qua Worker).
import { CONFIG } from "./config.js";

const DNSE_DIRECT = "https://services.entrade.com.vn/chart-api/v2/ohlcs";
const VN_OFFSET = 7 * 3600;

export const store = {
  meta: {},          // symbol -> {n, e, sh, pe, eps, dy}
  history: {},       // symbol -> {d, c, h, l, v}
  historyUpdatedAt: null,
  live: {},          // symbol -> {t, o, h, l, c, v, pc} (đơn vị đồng)
  lastLiveAt: null,
  scale: null,       // DNSE trả giá theo nghìn đồng -> nhân 1000
  directBlocked: false,
  official: false, // Worker có khoá DNSE OpenAPI
  directRest: null,
  directRestError: "",
};

export function settings() {
  let s = {};
  try { s = JSON.parse(localStorage.getItem("vns.settings") || "{}"); } catch {}
  return {
    workerUrl: (s.workerUrl ?? CONFIG.workerUrl ?? "").replace(/\/+$/, ""),
    interval: s.interval ?? 15,
    minAvgVol: s.minAvgVol ?? 10000,
    notify: s.notify ?? false,
    accessKey: s.accessKey ?? "",
  };
}
export function saveSettings(s) {
  try { localStorage.setItem("vns.settings", JSON.stringify(s)); } catch {}
}

export async function loadStatic() {
  const base = import.meta.env.BASE_URL + "data/";
  const [meta, hist] = await Promise.all([
    fetch(base + "meta.json", { cache: "no-cache" }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    fetch(base + "history.json", { cache: "no-cache" }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
  ]);
  store.meta = meta?.symbols || {};
  store.history = hist?.data || {};
  store.historyUpdatedAt = hist?.updatedAt || null;
  return !!hist;
}

// ---------------------------------------------------------------- giờ giao dịch
export function vnNow() {
  return new Date(Date.now() + (VN_OFFSET + new Date().getTimezoneOffset() * 60) * 1000);
}
export function vnDate(ts) {
  return new Date((ts + VN_OFFSET) * 1000).toISOString().slice(0, 10);
}
export function isMarketOpen() {
  const d = vnNow();
  const day = d.getDay();
  if (day === 0 || day === 6) return false;
  const m = d.getHours() * 60 + d.getMinutes();
  return m >= 9 * 60 && m <= 15 * 60; // 9:00 - 15:00
}

// ---------------------------------------------------------------- gọi API
async function getJson(url) {
  const s = settings();
  // Gửi kèm mật khẩu khi gọi Worker đã khoá
  const toWorker = s.workerUrl && url.startsWith(s.workerUrl);
  const r = await fetch(url, toWorker && s.accessKey ? { headers: { "X-Access-Key": s.accessKey } } : undefined);
  if (toWorker) store.authError = r.status === 401;
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.json();
}

// Gọi thẳng REST chính thức của DNSE từ máy người dùng (ở Việt Nam) bằng yêu cầu Worker đã ký sẵn.
// directRest: null = chưa thử, true = dùng được, false = không dùng được (vd DNSE không cho phép CORS)
async function directOhlc(s, symbol, resolution, from, to, kind) {
  const q = `symbol=${symbol}&resolution=${resolution}&from=${from}&to=${to}&type=${kind === "index" ? "INDEX" : "STOCK"}`;
  const p = await getJson(`${s.workerUrl}/presign?${q}`);
  const r = await fetch(p.url, { headers: p.headers, signal: AbortSignal.timeout(6000) });
  if (!r.ok) throw new Error("HTTP " + r.status + " " + (await r.text()).slice(0, 120));
  return r.json();
}

export async function fetchOhlc(symbol, resolution, from, to, kind = "stock") {
  const s = settings();
  let d;
  if (s.workerUrl && store.official && store.directRest !== false) {
    try {
      d = await directOhlc(s, symbol, resolution, from, to, kind);
      store.directRest = true;
    } catch (e) {
      store.directRest = false;
      store.directRestError = e instanceof TypeError ? "trình duyệt chặn (CORS) hoặc mất mạng" : e.message;
    }
  }
  if (d) {
    // đã có dữ liệu từ API chính thức
  } else if (s.workerUrl) {
    d = await getJson(`${s.workerUrl}/ohlc?symbol=${symbol}&resolution=${resolution}&from=${from}&to=${to}&kind=${kind}`);
  } else {
    d = await getJson(`${DNSE_DIRECT}/${kind}?symbol=${symbol}&resolution=${resolution}&from=${from}&to=${to}`);
  }
  const bars = [];
  const t = d.t || [];
  const k = kind === "stock" ? priceScale() : 1;
  for (let i = 0; i < t.length; i++) {
    if (d.c[i] == null) continue;
    bars.push({ time: t[i], open: d.o[i] * k, high: d.h[i] * k, low: d.l[i] * k, close: d.c[i] * k, volume: d.v[i] || 0 });
  }
  return bars;
}

function priceScale() {
  return store.scale ?? 1000;
}

// Ước lượng đơn vị giá của DNSE bằng cách so với dữ liệu lịch sử
function detectScale(raw) {
  const ratios = [];
  for (const [s, b] of Object.entries(raw)) {
    const h = store.history[s];
    if (h && b.pc && h.c.length) ratios.push(h.c[h.c.length - 1] / b.pc);
  }
  if (ratios.length < 3) return;
  ratios.sort((a, b) => a - b);
  const m = ratios[Math.floor(ratios.length / 2)];
  store.scale = m > 100 ? 1000 : 1;
}

async function fetchSnapshotBatch(symbols) {
  const s = settings();
  if (s.workerUrl) {
    const d = await getJson(`${s.workerUrl}/snapshot?symbols=${symbols.join(",")}`);
    return d.data || {};
  }
  // Không có Worker: thử gọi thẳng DNSE (có thể bị trình duyệt chặn CORS)
  const now = Math.floor(Date.now() / 1000);
  const out = {};
  await Promise.all(symbols.map(async (sym) => {
    try {
      const d = await getJson(`${DNSE_DIRECT}/stock?symbol=${sym}&resolution=1D&from=${now - 12 * 86400}&to=${now + 86400}`);
      const n = d.t?.length || 0;
      if (n) out[sym] = { t: d.t[n - 1], o: d.o[n - 1], h: d.h[n - 1], l: d.l[n - 1], c: d.c[n - 1], v: d.v[n - 1], pc: n > 1 ? d.c[n - 2] : null };
    } catch (e) {
      if (e instanceof TypeError) store.directBlocked = true;
    }
  }));
  return out;
}

// Nguồn 1: bảng giá cả sàn từ SSI qua Worker (3 lần gọi cho toàn thị trường)
let boardBrokenAt = 0;
async function refreshBoard(exchanges) {
  const s = settings();
  if (!s.workerUrl || Date.now() - boardBrokenAt < 5 * 60 * 1000) return null;
  let ok = 0;
  const results = await Promise.allSettled(exchanges.map((ex) => getJson(`${s.workerUrl}/board?ex=${ex.toLowerCase()}`)));
  for (const r of results) {
    if (r.status !== "fulfilled") continue;
    for (const x of r.value.data || []) {
      if (!x.r) continue;
      const d = String(x.d || "");
      const t = Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8), 2) / 1000; // 9:00 giờ VN
      if (!x.v || !x.c) {
        // chưa có giao dịch trong phiên: chỉ ghi nhận giá tham chiếu
        store.live[x.s] = { t, o: x.r, h: x.r, l: x.r, c: x.r, v: 0, pc: x.r, ce: x.ce, fl: x.fl, noTrade: true };
      } else {
        store.live[x.s] = { t, o: x.o || x.c, h: x.h || x.c, l: x.l || x.c, c: x.c, v: x.v, pc: x.r, ce: x.ce, fl: x.fl };
      }
      if (x.n && store.meta[x.s] && !store.meta[x.s].n) store.meta[x.s].n = x.n;
      ok++;
    }
  }
  if (!ok) {
    boardBrokenAt = Date.now(); // Worker chưa hỗ trợ /board hoặc SSI chặn -> dùng DNSE, 5 phút sau thử lại
    return null;
  }
  return { ok, failed: 0, source: "SSI" };
}

// Lấy giá trong phiên: ưu tiên bảng giá SSI, dự phòng DNSE từng lô mã
export async function refreshLive(symbols, onProgress, exchanges = ["HOSE", "HNX", "UPCOM"]) {
  const board = await refreshBoard(exchanges);
  if (board) {
    store.lastLiveAt = new Date();
    store.source = "SSI";
    return board;
  }
  store.source = "DNSE";
  return refreshDnse(symbols, onProgress);
}

async function refreshDnse(symbols, onProgress) {
  const batchSize = settings().workerUrl ? 45 : 10;
  const batches = [];
  for (let i = 0; i < symbols.length; i += batchSize) batches.push(symbols.slice(i, i + batchSize));
  let ok = 0, failed = 0;
  const concurrency = 4;
  let next = 0;
  async function worker() {
    while (next < batches.length) {
      const b = batches[next++];
      try {
        const raw = await fetchSnapshotBatch(b);
        if (store.scale == null) detectScale(raw);
        const k = priceScale();
        for (const [s, x] of Object.entries(raw)) {
          if (x.error || x.c == null) { failed++; continue; }
          store.live[s] = { t: x.t, o: x.o * k, h: x.h * k, l: x.l * k, c: x.c * k, v: x.v || 0, pc: x.pc == null ? null : x.pc * k };
          ok++;
        }
      } catch {
        failed += b.length;
      }
      onProgress?.();
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, batches.length) }, worker));
  if (ok) store.lastLiveAt = new Date();
  return { ok, failed };
}

// Ghép lịch sử + nến hôm nay thành chuỗi dữ liệu để tính chỉ báo
// Ngày giao dịch của từng nến (số ngày kể từ 1/1/1970), null nếu dữ liệu cũ chưa có
export function daysOf(sym) {
  const h = store.history[sym];
  if (!h || h.t0 == null || !h.dt) return null;
  if (!h._days) {
    const d = [h.t0];
    for (const x of h.dt) d.push(d[d.length - 1] + x);
    h._days = d;
  }
  return h._days;
}

export const dayToStr = (n) => new Date(n * 86400000).toISOString().slice(0, 10);
export const strToDay = (s) => Math.floor(Date.parse(s + "T00:00:00Z") / 86400000);

// Lịch giao dịch (lấy từ mã có lịch sử dài nhất) dùng cho chọn ngày backtest
export function tradingCalendar() {
  if (store._calendar) return store._calendar;
  let best = null;
  for (const sym of Object.keys(store.history)) {
    const d = daysOf(sym);
    if (d && (!best || d.length > best.length)) best = d;
  }
  store._calendar = best || [];
  return store._calendar;
}

// Vị trí nến cuối cùng có ngày <= asOf
function indexAsOf(days, asOf) {
  let lo = 0, hi = days.length - 1, ans = -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (days[m] <= asOf) { ans = m; lo = m + 1; } else hi = m - 1;
  }
  return ans;
}

// Ghép lịch sử + nến hôm nay thành chuỗi dữ liệu để tính chỉ báo.
// asOf (số ngày): cắt dữ liệu tại ngày đó để backtest, bỏ qua giá realtime.
export function barsFor(sym, asOf = null) {
  const h = store.history[sym];
  if (asOf != null) {
    const days = daysOf(sym);
    if (!h || !days) return null;
    const i = indexAsOf(days, asOf);
    if (i < 1 || asOf - days[i] > 7) return null; // chưa niêm yết hoặc đang ngừng giao dịch
    const n = i + 1;
    return { c: h.c.slice(0, n), h: h.h.slice(0, n), l: h.l.slice(0, n), v: h.v.slice(0, n), o: h.o ? h.o.slice(0, n) : new Array(n).fill(null), idx: i };
  }
  const lv = store.live[sym];
  if (!h && !lv) return null;
  const c = h ? h.c.slice() : [], hi = h ? h.h.slice() : [], lo = h ? h.l.slice() : [], v = h ? h.v.slice() : [];
  const o = h?.o ? h.o.slice() : new Array(c.length).fill(null);
  if (lv && !lv.noTrade) {
    const d = vnDate(lv.t);
    const lastD = h?.d;
    if (!lastD || d > lastD) {
      if (!h && lv.pc != null) { c.push(lv.pc); hi.push(lv.pc); lo.push(lv.pc); v.push(0); o.push(null); }
      c.push(lv.c); hi.push(lv.h); lo.push(lv.l); v.push(lv.v); o.push(lv.o);
    } else if (d === lastD) {
      const i = c.length - 1;
      c[i] = lv.c; hi[i] = lv.h; lo[i] = lv.l; v[i] = lv.v; o[i] = lv.o;
    }
  }
  return { c, h: hi, l: lo, v, o };
}

// Lợi nhuận (%) sau k phiên kể từ nến idx; k = "now" là đến giá gần nhất
export function forwardReturn(sym, idx, k) {
  const h = store.history[sym];
  if (!h) return null;
  const base = h.c[idx];
  if (!base) return null;
  if (k === "now") {
    const lv = store.live[sym];
    const last = lv && !lv.noTrade && vnDate(lv.t) > h.d ? lv.c : h.c[h.c.length - 1];
    return (last / base - 1) * 100;
  }
  const j = idx + k;
  return j < h.c.length ? (h.c[j] / base - 1) * 100 : null;
}

export function lastDate(sym) {
  const lv = store.live[sym];
  if (lv) return vnDate(lv.t);
  return store.history[sym]?.d;
}

export function avgVol20(sym) {
  const h = store.history[sym];
  if (!h || h.v.length === 0) return 0;
  const v = h.v.slice(-20);
  return v.reduce((a, b) => a + b, 0) / v.length;
}
