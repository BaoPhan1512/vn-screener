// Các chỉ báo kỹ thuật. Mỗi hàm nhận mảng số, trả về mảng cùng độ dài
// (các phần tử đầu chưa đủ dữ liệu là null).

export function sma(src, n) {
  const out = new Array(src.length).fill(null);
  let sum = 0;
  for (let i = 0; i < src.length; i++) {
    sum += src[i];
    if (i >= n) sum -= src[i - n];
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

export function ema(src, n) {
  const out = new Array(src.length).fill(null);
  if (src.length < n) return out;
  const k = 2 / (n + 1);
  let prev = 0;
  for (let i = 0; i < n; i++) prev += src[i];
  prev /= n;
  out[n - 1] = prev;
  for (let i = n; i < src.length; i++) {
    prev = src[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

// RSI theo Wilder (giống TradingView)
export function rsi(src, n = 14) {
  const out = new Array(src.length).fill(null);
  if (src.length <= n) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= n; i++) {
    const d = src[i] - src[i - 1];
    if (d > 0) gain += d; else loss -= d;
  }
  gain /= n; loss /= n;
  out[n] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  for (let i = n + 1; i < src.length; i++) {
    const d = src[i] - src[i - 1];
    gain = (gain * (n - 1) + Math.max(d, 0)) / n;
    loss = (loss * (n - 1) + Math.max(-d, 0)) / n;
    out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return out;
}

export function macd(src, fast = 12, slow = 26, signal = 9) {
  const f = ema(src, fast), s = ema(src, slow);
  const line = src.map((_, i) => (f[i] == null || s[i] == null ? null : f[i] - s[i]));
  const start = line.findIndex((x) => x != null);
  const sig = new Array(src.length).fill(null);
  if (start >= 0) {
    const e = ema(line.slice(start), signal);
    for (let i = 0; i < e.length; i++) sig[start + i] = e[i];
  }
  const hist = line.map((x, i) => (x == null || sig[i] == null ? null : x - sig[i]));
  return { line, signal: sig, hist };
}

export function stdev(src, n) {
  const m = sma(src, n);
  return src.map((_, i) => {
    if (m[i] == null) return null;
    let s = 0;
    for (let j = i - n + 1; j <= i; j++) s += (src[j] - m[i]) ** 2;
    return Math.sqrt(s / n);
  });
}

export function bollinger(src, n = 20, mult = 2) {
  const mid = sma(src, n), sd = stdev(src, n);
  return {
    mid,
    upper: mid.map((x, i) => (x == null ? null : x + mult * sd[i])),
    lower: mid.map((x, i) => (x == null ? null : x - mult * sd[i])),
  };
}

export function atr(high, low, close, n = 14) {
  const tr = close.map((c, i) =>
    i === 0 ? high[i] - low[i] : Math.max(high[i] - low[i], Math.abs(high[i] - close[i - 1]), Math.abs(low[i] - close[i - 1]))
  );
  const out = new Array(close.length).fill(null);
  if (close.length < n) return out;
  let a = 0;
  for (let i = 0; i < n; i++) a += tr[i];
  a /= n;
  out[n - 1] = a;
  for (let i = n; i < close.length; i++) {
    a = (a * (n - 1) + tr[i]) / n;
    out[i] = a;
  }
  return out;
}

// Giá trị lớn nhất / nhỏ nhất trong n phiên (tính cả phiên hiện tại)
export function highest(src, n) {
  return src.map((_, i) => (i < n - 1 ? null : Math.max(...src.slice(i - n + 1, i + 1))));
}
export function lowest(src, n) {
  return src.map((_, i) => (i < n - 1 ? null : Math.min(...src.slice(i - n + 1, i + 1))));
}
