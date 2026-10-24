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
};

export function settings() {
  let s = {};
  try { s = JSON.parse(localStorage.getItem("vns.settings") || "{}"); } catch {}
  return {
    workerUrl: (s.workerUrl ?? CONFIG.workerUrl ?? "").replace(/\/+$/, ""),
    interval: s.interval ?? 15,
    minAvgVol: s.minAvgVol ?? 10000,
    notify: s.notify ?? false,
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
  const r = await fetch(url);
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.json();
}

export async function fetchOhlc(symbol, resolution, from, to, kind = "stock") {
  const s = settings();
  let d;
  if (s.workerUrl) {
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

// Lấy giá trong phiên cho danh sách mã, chia lô và chạy song song
export async function refreshLive(symbols, onProgress) {
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
export function barsFor(sym) {
  const h = store.history[sym];
  const lv = store.live[sym];
  if (!h && !lv) return null;
  const c = h ? h.c.slice() : [], hi = h ? h.h.slice() : [], lo = h ? h.l.slice() : [], v = h ? h.v.slice() : [];
  const o = new Array(c.length).fill(null);
  if (lv) {
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
