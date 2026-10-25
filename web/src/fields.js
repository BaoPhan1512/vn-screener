// Danh mục các trường dữ liệu dùng được trong bộ lọc và trong bảng.
// Mỗi trường trả về một chuỗi giá trị (series) khớp với các nến ngày,
// nhờ vậy so sánh được cả "hôm nay" lẫn "hôm qua" (dùng cho điều kiện cắt lên/xuống).
import * as ind from "./indicators.js";

const shift = (arr, k = 1) => arr.map((_, i) => (i - k >= 0 ? arr[i - k] : null));
const pctChange = (c, n) => c.map((x, i) => (i - n >= 0 && c[i - n] ? (x / c[i - n] - 1) * 100 : null));

const LIMIT_PCT = { HOSE: 0.07, HNX: 0.1, UPCOM: 0.15 };

// fmt: price | pct | num | vol | money | ratio
export const FIELDS = {
  price:   { label: "Giá", group: "Giá", fmt: "price", series: (x) => x.c },
  open:    { label: "Giá mở cửa", group: "Giá", fmt: "price", series: (x) => x.o },
  high:    { label: "Giá cao nhất", group: "Giá", fmt: "price", series: (x) => x.h },
  low:     { label: "Giá thấp nhất", group: "Giá", fmt: "price", series: (x) => x.l },
  chg:     { label: "% Thay đổi", short: "% T.đổi", group: "Giá", fmt: "pct", series: (x) => pctChange(x.c, 1) },
  chgAbs:  { label: "Thay đổi (đ)", group: "Giá", fmt: "price", sign: true, series: (x) => x.c.map((v, i) => (i ? v - x.c[i - 1] : null)) },
  perf:    { label: "Hiệu suất N phiên (%)", short: "Hiệu suất", group: "Giá", fmt: "pct", params: [{ name: "N", def: 5 }], series: (x, [n]) => pctChange(x.c, n) },
  hiN:     { label: "Đỉnh N phiên trước", short: "Đỉnh", group: "Giá", fmt: "price", params: [{ name: "N", def: 20 }], series: (x, [n]) => shift(ind.highest(x.h, n)) },
  loN:     { label: "Đáy N phiên trước", short: "Đáy", group: "Giá", fmt: "price", params: [{ name: "N", def: 20 }], series: (x, [n]) => shift(ind.lowest(x.l, n)) },
  high52:  { label: "Đỉnh 52 tuần", group: "Giá", fmt: "price", series: (x) => ind.highest(x.h, Math.min(250, x.h.length)) },
  low52:   { label: "Đáy 52 tuần", group: "Giá", fmt: "price", series: (x) => ind.lowest(x.l, Math.min(250, x.l.length)) },
  fromHigh52: { label: "% So với đỉnh 52 tuần", short: "% vs đỉnh 52T", group: "Giá", fmt: "pct",
    series: (x, _p, get) => { const h = get("high52"); return x.c.map((v, i) => (h[i] ? (v / h[i] - 1) * 100 : null)); } },

  vol:     { label: "Khối lượng", short: "KL", group: "Khối lượng", fmt: "vol", series: (x) => x.v },
  value:   { label: "Giá trị giao dịch", short: "GTGD", group: "Khối lượng", fmt: "money", series: (x) => x.c.map((v, i) => v * x.v[i]) },
  avgVol:  { label: "KL trung bình N phiên", short: "KL TB", group: "Khối lượng", fmt: "vol", params: [{ name: "N", def: 20 }], series: (x, [n]) => shift(ind.sma(x.v, n)) },
  relVol:  { label: "KL tương đối (so với TB N phiên)", short: "KL t.đối", group: "Khối lượng", fmt: "num", params: [{ name: "N", def: 20 }],
    series: (x, [n]) => { const a = shift(ind.sma(x.v, n)); return x.v.map((v, i) => (a[i] ? v / a[i] : null)); } },

  sma:     { label: "SMA", group: "Chỉ báo", fmt: "price", params: [{ name: "Chu kỳ", def: 20 }], series: (x, [n]) => ind.sma(x.c, n) },
  ema:     { label: "EMA", group: "Chỉ báo", fmt: "price", params: [{ name: "Chu kỳ", def: 20 }], series: (x, [n]) => ind.ema(x.c, n) },
  smaVol:  { label: "SMA khối lượng", short: "SMA KL", group: "Chỉ báo", fmt: "vol", params: [{ name: "Chu kỳ", def: 20 }], series: (x, [n]) => ind.sma(x.v, n) },
  rsi:     { label: "RSI", group: "Chỉ báo", fmt: "num", params: [{ name: "Chu kỳ", def: 14 }], series: (x, [n]) => ind.rsi(x.c, n) },
  macd:    { label: "MACD", group: "Chỉ báo", fmt: "num", params: [{ name: "Nhanh", def: 12 }, { name: "Chậm", def: 26 }, { name: "Tín hiệu", def: 9 }], series: (x, p) => ind.macd(x.c, ...p).line },
  macdSig: { label: "MACD Signal", group: "Chỉ báo", fmt: "num", params: [{ name: "Nhanh", def: 12 }, { name: "Chậm", def: 26 }, { name: "Tín hiệu", def: 9 }], series: (x, p) => ind.macd(x.c, ...p).signal },
  macdHist:{ label: "MACD Histogram", short: "MACD Hist", group: "Chỉ báo", fmt: "num", params: [{ name: "Nhanh", def: 12 }, { name: "Chậm", def: 26 }, { name: "Tín hiệu", def: 9 }], series: (x, p) => ind.macd(x.c, ...p).hist },
  bbUpper: { label: "Bollinger trên", short: "BB trên", group: "Chỉ báo", fmt: "price", params: [{ name: "Chu kỳ", def: 20 }, { name: "Độ lệch", def: 2 }], series: (x, [n, k]) => ind.bollinger(x.c, n, k).upper },
  bbLower: { label: "Bollinger dưới", short: "BB dưới", group: "Chỉ báo", fmt: "price", params: [{ name: "Chu kỳ", def: 20 }, { name: "Độ lệch", def: 2 }], series: (x, [n, k]) => ind.bollinger(x.c, n, k).lower },
  trix:    { label: "TRIX", group: "Chỉ báo", fmt: "num", params: [{ name: "Chu kỳ", def: 3 }], series: (x, [n]) => ind.trix(x.c, n) },
  trixSig: { label: "MA của TRIX (đường tín hiệu)", short: "MA TRIX", group: "Chỉ báo", fmt: "num", params: [{ name: "Chu kỳ TRIX", def: 3 }, { name: "Chu kỳ MA", def: 6 }],
    series: (x, [n, m], get) => ind.smaSeries(get("trix", [n]), m) },
  asi:     { label: "ASI (Accumulative Swing Index)", short: "ASI", group: "Chỉ báo", fmt: "num",
    series: (x) => ind.asi(x.o, x.h, x.l, x.c, LIMIT_PCT[x.meta.e] || 0.07) },
  atrPct:  { label: "ATR (% giá)", short: "ATR%", group: "Chỉ báo", fmt: "pct", params: [{ name: "Chu kỳ", def: 14 }],
    series: (x, [n]) => ind.atr(x.h, x.l, x.c, n).map((a, i) => (a == null ? null : (a / x.c[i]) * 100)) },

  mktcap:  { label: "Vốn hoá", group: "Cơ bản", fmt: "money", series: (x) => x.c.map((v) => (x.meta.sh ? v * x.meta.sh : null)) },
  pe:      { label: "P/E", group: "Cơ bản", fmt: "ratio", series: (x) => x.c.map((v) => (x.meta.eps > 0 ? v / x.meta.eps : null)) },
  eps:     { label: "EPS", group: "Cơ bản", fmt: "price", series: (x) => x.c.map(() => x.meta.eps ?? null) },
  divYield:{ label: "Tỷ suất cổ tức (%)", short: "Cổ tức %", group: "Cơ bản", fmt: "pct", unsigned: true,
    series: (x) => x.c.map(() => (x.meta.dy == null ? null : x.meta.dy < 1 ? x.meta.dy * 100 : x.meta.dy)) },
};

export const OPERATORS = {
  ">": { label: ">" },
  ">=": { label: "≥" },
  "<": { label: "<" },
  "<=": { label: "≤" },
  crossUp: { label: "cắt lên ↗" },
  crossDown: { label: "cắt xuống ↘" },
  between: { label: "trong khoảng" },
  rising: { label: "hướng lên ↑", unary: true },
  falling: { label: "hướng xuống ↓", unary: true },
};

export function defaultParams(key) {
  return (FIELDS[key].params || []).map((p) => p.def);
}

// Tên ngắn gọn của một toán hạng, ví dụ "EMA 2", "Giá", "RSI 14"
export function operandLabel(o, short = true) {
  if (!o) return "";
  if (o.v !== undefined) return formatInput(o.v, o.unit);
  const f = FIELDS[o.f];
  if (!f) return o.f;
  const name = short ? f.short || f.label : f.label;
  const p = o.p && o.p.length ? " " + o.p.join(", ") : "";
  return name.replace(" N phiên", "").replace(" (%)", "") + p;
}

export function operandKey(o) {
  return o.f + (o.p && o.p.length ? "(" + o.p.join(",") + ")" : "");
}

// Bộ nhớ đệm chỉ báo cho một mã trong một chu kỳ cập nhật
export function makeContext(sym, bars, meta) {
  const cache = new Map();
  const ctx = { sym, meta: meta || {}, ...bars };
  ctx.get = (key, params) => {
    const p = params && params.length ? params : defaultParams(key);
    const k = key + "|" + p.join(",");
    if (!cache.has(k)) cache.set(k, FIELDS[key].series(ctx, p, (k2, p2) => ctx.get(k2, p2)));
    return cache.get(k);
  };
  // giá trị của toán hạng tại vị trí cách cuối "back" phiên
  ctx.value = (o, back = 0) => {
    if (o.v !== undefined) return o.v;
    if (!FIELDS[o.f]) return null;
    const s = ctx.get(o.f, o.p);
    const i = s.length - 1 - back;
    return i >= 0 ? s[i] : null;
  };
  return ctx;
}

// ---- định dạng số kiểu TradingView: 8.71M, 129.14T
export function compact(n, digits = 2) {
  if (n == null || !isFinite(n)) return "—";
  const a = Math.abs(n);
  const units = [[1e12, "T"], [1e9, "B"], [1e6, "M"], [1e3, "K"]];
  for (const [u, s] of units) if (a >= u) return (n / u).toFixed(digits).replace(/\.?0+$/, "") + s;
  return String(Math.round(n * 100) / 100);
}

export function formatValue(n, fmt, field) {
  if (n == null || !isFinite(n)) return "—";
  switch (fmt) {
    case "price": {
      const s = Math.round(n).toLocaleString("en-US");
      return field?.sign && n > 0 ? "+" + s : s;
    }
    case "pct":
      return (n > 0 && !field?.unsigned ? "+" : "") + n.toFixed(2) + "%";
    case "vol":
    case "money":
      return compact(n);
    case "ratio":
      return n.toFixed(2);
    default:
      return Math.abs(n) >= 1000 ? compact(n) : n.toFixed(2);
  }
}

// Hiển thị lại số người dùng đã nhập
export function formatInput(v, unit) {
  if (unit === "pct") return v + "%";
  return Math.abs(v) >= 1000 ? compact(v, 3) : String(v);
}

// "50K" -> 50000, "1T" -> 1e12, "1,5B" -> 1.5e9, "0.3%" -> 0.3
export function parseNumber(str) {
  if (str == null) return NaN;
  const s = String(str).trim().toUpperCase().replace(/\s/g, "").replace("%", "");
  const m = s.match(/^(-?[\d.,]+)([KMBT]|TỶ|TY|NGHÌN|TRIỆU)?$/);
  if (!m) return NaN;
  let num = m[1];
  // "1,5" -> 1.5 ; "50,000" -> 50000
  if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(num)) num = num.replace(/,/g, "");
  else num = num.replace(",", ".");
  const mult = { K: 1e3, M: 1e6, B: 1e9, T: 1e12, "TỶ": 1e9, TY: 1e9, "NGHÌN": 1e3, "TRIỆU": 1e6 }[m[2]] || 1;
  return parseFloat(num) * mult;
}
