// Các bộ lọc đã lưu (lưu trong trình duyệt) + mẫu có sẵn + chia sẻ qua link.

const F = (f, ...p) => ({ f, p });
const V = (v, unit) => (unit ? { v, unit } : { v });

export const TEMPLATES = [
  {
    name: "Ema > MA",
    filters: [
      { left: F("price"), op: "crossUp", right: F("sma", 20) },
      { left: F("chg"), op: ">", right: V(0.3, "pct") },
      { left: F("mktcap"), op: ">", right: V(1e12) },
      { left: F("ema", 2), op: ">", right: F("ema", 5) },
      { left: F("price"), op: ">", right: V(5000) },
      { left: F("vol"), op: ">", right: V(50000) },
      { left: F("sma", 2), op: ">", right: F("sma", 10) },
    ],
  },
  {
    name: "Vượt đỉnh 20 phiên + KL đột biến",
    filters: [
      { left: F("price"), op: ">", right: F("hiN", 20) },
      { left: F("relVol", 20), op: ">", right: V(1.5) },
      { left: F("value"), op: ">", right: V(5e9) },
    ],
  },
  {
    name: "Xu hướng tăng (Giá > MA20 > MA50 > MA200)",
    filters: [
      { left: F("price"), op: ">", right: F("sma", 20) },
      { left: F("sma", 20), op: ">", right: F("sma", 50) },
      { left: F("sma", 50), op: ">", right: F("sma", 200) },
      { left: F("avgVol", 20), op: ">", right: V(100000) },
    ],
  },
  {
    name: "MACD cắt lên Signal",
    filters: [
      { left: F("macd", 12, 26, 9), op: "crossUp", right: F("macdSig", 12, 26, 9) },
      { left: F("avgVol", 20), op: ">", right: V(100000) },
    ],
  },
  {
    name: "RSI quá bán (< 30)",
    filters: [
      { left: F("rsi", 14), op: "<", right: V(30) },
      { left: F("avgVol", 20), op: ">", right: V(100000) },
    ],
  },
  {
    name: "Gần đỉnh 52 tuần",
    filters: [
      { left: F("fromHigh52"), op: ">", right: V(-3, "pct") },
      { left: F("value"), op: ">", right: V(10e9) },
    ],
  },
  { name: "Tất cả cổ phiếu", filters: [] },
];

const KEY = "vns.screens";

export function loadScreens() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || "null");
    if (s && Array.isArray(s.list) && s.list.length) return s;
  } catch {}
  return { current: 0, list: [structuredClone({ ...TEMPLATES[0], exchanges: ["HOSE", "HNX", "UPCOM"] })] };
}

export function saveScreens(s) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch {}
}

// Mã hoá bộ lọc vào link để chia sẻ (không cần máy chủ)
export function encodeScreen(screen) {
  const json = JSON.stringify({ n: screen.name, f: screen.filters, e: screen.exchanges });
  return btoa(unescape(encodeURIComponent(json))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeScreen(str) {
  try {
    const b64 = str.replace(/-/g, "+").replace(/_/g, "/");
    const o = JSON.parse(decodeURIComponent(escape(atob(b64))));
    return { name: o.n || "Bộ lọc được chia sẻ", filters: o.f || [], exchanges: o.e || ["HOSE", "HNX", "UPCOM"] };
  } catch {
    return null;
  }
}

export function loadWatchlist() {
  try { return new Set(JSON.parse(localStorage.getItem("vns.watch") || "[]")); } catch { return new Set(); }
}
export function saveWatchlist(set) {
  try { localStorage.setItem("vns.watch", JSON.stringify([...set])); } catch {}
}
