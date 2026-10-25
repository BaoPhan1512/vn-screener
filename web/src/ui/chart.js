// Biểu đồ giá kiểu TradingView, dùng thư viện Lightweight Charts (miễn phí, của TradingView).
import { createChart, CandlestickSeries, HistogramSeries, LineSeries, CrosshairMode, createSeriesMarkers } from "lightweight-charts";
import { fetchOhlc, store, isMarketOpen, vnDate } from "../data.js";
import * as ind from "../indicators.js";

const VN = 7 * 3600;
const TIMEFRAMES = [
  { key: "1", label: "1m", days: 5 },
  { key: "5", label: "5m", days: 20 },
  { key: "15", label: "15m", days: 45 },
  { key: "1H", label: "1H", days: 120 },
  { key: "1D", label: "1D", days: 900 },
  { key: "1W", label: "1W", days: 3000 },
];
const OVERLAYS = [
  { key: "ma20", label: "MA20", color: "#f59e0b", calc: (c) => ind.sma(c, 20) },
  { key: "ma50", label: "MA50", color: "#8b5cf6", calc: (c) => ind.sma(c, 50) },
  { key: "ma200", label: "MA200", color: "#ef4444", calc: (c) => ind.sma(c, 200) },
  { key: "ema9", label: "EMA9", color: "#06b6d4", calc: (c) => ind.ema(c, 9) },
  { key: "bb", label: "BB", color: "#94a3b8", calc: (c) => ind.bollinger(c, 20, 2) },
];
const PANES = [
  { key: "rsi", label: "RSI" },
  { key: "macd", label: "MACD" },
  { key: "trix", label: "TRIX" },
  { key: "asi", label: "ASI" },
];
const LIMIT_PCT = { HOSE: 0.07, HNX: 0.1, UPCOM: 0.15 };

function prefs() {
  try {
    return { tf: "1D", on: { ma20: true, ma50: true }, panes: {}, ...JSON.parse(localStorage.getItem("vns.chart") || "{}") };
  } catch {
    return { tf: "1D", on: { ma20: true, ma50: true }, panes: {} };
  }
}

export class ChartPanel {
  constructor(root) {
    this.root = root;
    this.p = prefs();
    this.symbol = null;
    this.bars = [];
    this.timer = null;
    this.seq = 0;
    root.innerHTML = `
      <div class="cp-head">
        <div class="cp-title"><b class="cp-sym"></b><span class="cp-name"></span></div>
        <div class="cp-quote"><span class="cp-price"></span><span class="cp-chg"></span></div>
        <div class="cp-links">
          <a class="cp-tv" target="_blank" rel="noopener" title="Mở trên TradingView">TV</a>
          <a class="cp-fa" target="_blank" rel="noopener" title="Mở trên FireAnt">FA</a>
          <button class="cp-close icon-btn" title="Đóng (Esc)">✕</button>
        </div>
      </div>
      <div class="cp-tools">
        <div class="seg cp-tf">${TIMEFRAMES.map((t) => `<button data-tf="${t.key}">${t.label}</button>`).join("")}</div>
        <div class="seg cp-ov">${OVERLAYS.map((o) => `<button data-ov="${o.key}"><i style="background:${o.color}"></i>${o.label}</button>`).join("")}
        ${PANES.map((o) => `<button data-pane="${o.key}">${o.label}</button>`).join("")}</div>
      </div>
      <div class="cp-legend"></div>
      <div class="cp-chart"></div>
      <div class="cp-msg"></div>`;
    this.el = root.querySelector(".cp-chart");
    root.querySelector(".cp-close").onclick = () => this.onClose?.();
    root.querySelector(".cp-tf").onclick = (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      this.p.tf = b.dataset.tf;
      this.save();
      this.load();
    };
    root.querySelector(".cp-ov").onclick = (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      if (b.dataset.ov) this.p.on[b.dataset.ov] = !this.p.on[b.dataset.ov];
      if (b.dataset.pane) this.p.panes[b.dataset.pane] = !this.p.panes[b.dataset.pane];
      this.save();
      this.build();
      this.render(true);
    };
    new ResizeObserver(() => this.chart?.resize(this.el.clientWidth, this.el.clientHeight)).observe(this.el);
    this.build();
  }

  save() {
    try { localStorage.setItem("vns.chart", JSON.stringify(this.p)); } catch {}
  }

  colors() {
    const cs = getComputedStyle(document.documentElement);
    const g = (n) => cs.getPropertyValue(n).trim();
    return { bg: g("--bg"), text: g("--text-2"), grid: g("--grid"), up: g("--up"), down: g("--down") };
  }

  build() {
    this.chart?.remove();
    const c = this.colors();
    this.chart = createChart(this.el, {
      autoSize: true,
      layout: { background: { color: c.bg }, textColor: c.text, fontFamily: "inherit", panes: { separatorColor: c.grid } },
      grid: { vertLines: { color: c.grid }, horzLines: { color: c.grid } },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderVisible: false },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false, rightOffset: 4 },
      localization: { priceFormatter: (p) => Math.round(p).toLocaleString("en-US") },
    });
    this.candle = this.chart.addSeries(CandlestickSeries, {
      upColor: c.up, downColor: c.down, borderVisible: false, wickUpColor: c.up, wickDownColor: c.down,
    });
    this.volume = this.chart.addSeries(HistogramSeries, { priceScaleId: "vol", priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false });
    this.chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
    this.lines = {};
    for (const o of OVERLAYS) {
      if (!this.p.on[o.key]) continue;
      const opt = { color: o.color, lineWidth: o.key === "bb" ? 1 : 2, lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false };
      this.lines[o.key] = o.key === "bb"
        ? [this.chart.addSeries(LineSeries, opt), this.chart.addSeries(LineSeries, opt)]
        : this.chart.addSeries(LineSeries, opt);
    }
    let pane = 1;
    this.paneSeries = {};
    const lineOpt = { lineWidth: 1.5, lastValueVisible: true, priceLineVisible: false };
    if (this.p.panes.rsi) {
      this.paneSeries.rsi = this.chart.addSeries(LineSeries, { ...lineOpt, color: "#8b5cf6" }, pane);
      for (const lv of [70, 30]) this.paneSeries.rsi.createPriceLine({ price: lv, color: c.text, lineStyle: 2, lineWidth: 1, axisLabelVisible: false });
      pane++;
    }
    if (this.p.panes.macd) {
      this.paneSeries.macdHist = this.chart.addSeries(HistogramSeries, { lastValueVisible: false, priceLineVisible: false }, pane);
      this.paneSeries.macd = this.chart.addSeries(LineSeries, { ...lineOpt, color: "#2962ff" }, pane);
      this.paneSeries.macdSig = this.chart.addSeries(LineSeries, { ...lineOpt, color: "#ff6d00" }, pane);
      pane++;
    }
    if (this.p.panes.trix) {
      this.paneSeries.trix = this.chart.addSeries(LineSeries, { ...lineOpt, color: "#2962ff", title: "TRIX 3" }, pane);
      this.paneSeries.trixSig = this.chart.addSeries(LineSeries, { ...lineOpt, color: "#ff6d00", title: "MA 6" }, pane);
      pane++;
    }
    if (this.p.panes.asi) {
      this.paneSeries.asi = this.chart.addSeries(LineSeries, { ...lineOpt, color: "#0891b2", title: "ASI" }, pane);
      pane++;
    }
    this.markers = createSeriesMarkers(this.candle, []);
    const panes = this.chart.panes();
    for (let i = 1; i < panes.length; i++) panes[i].setStretchFactor(0.35);
    this.chart.subscribeCrosshairMove((param) => this.legend(param));
    this.syncButtons();
  }

  syncButtons() {
    this.root.querySelectorAll(".cp-tf button").forEach((b) => b.classList.toggle("on", b.dataset.tf === this.p.tf));
    this.root.querySelectorAll(".cp-ov button").forEach((b) =>
      b.classList.toggle("on", !!(b.dataset.ov ? this.p.on[b.dataset.ov] : this.p.panes[b.dataset.pane]))
    );
  }

  async show(symbol) {
    this.symbol = symbol;
    const m = store.meta[symbol] || {};
    this.root.querySelector(".cp-sym").textContent = symbol;
    this.root.querySelector(".cp-name").textContent = m.n || "";
    const ex = m.e === "HOSE" ? "HOSE" : m.e === "HNX" ? "HNX" : "UPCOM";
    this.root.querySelector(".cp-tv").href = `https://www.tradingview.com/chart/?symbol=${ex}:${symbol}`;
    this.root.querySelector(".cp-fa").href = `https://fireant.vn/ma-chung-khoan/${symbol}`;
    await this.load();
  }

  async load() {
    const seq = ++this.seq;
    const tf = TIMEFRAMES.find((t) => t.key === this.p.tf) || TIMEFRAMES[4];
    this.syncButtons();
    this.msg("Đang tải…");
    const now = Math.floor(Date.now() / 1000);
    let bars = [];
    try {
      bars = await fetchOhlc(this.symbol, tf.key, now - tf.days * 86400, now + 86400);
    } catch {
      bars = [];
    }
    if (seq !== this.seq) return;
    if (!bars.length && (tf.key === "1D")) bars = this.localDaily();
    if (!bars.length) {
      this.bars = [];
      this.render(true);
      this.msg("Không tải được dữ liệu biểu đồ. Kiểm tra mục Cài đặt → địa chỉ Worker.");
      return;
    }
    this.msg("");
    this.bars = bars;
    this.render(true);
    this.startLive();
  }

  // Dự phòng: vẽ biểu đồ ngày từ dữ liệu lịch sử có sẵn
  localDaily() {
    const h = store.history[this.symbol];
    if (!h) return [];
    const end = Date.parse(h.d + "T00:00:00Z") / 1000;
    let t = end;
    const times = [];
    for (let i = h.c.length - 1; i >= 0; i--) {
      times.unshift(t);
      do t -= 86400; while ([0, 6].includes(new Date(t * 1000).getUTCDay()));
    }
    return h.c.map((c, i) => ({ time: times[i] - VN, open: h.c[i - 1] ?? c, high: h.h[i], low: h.l[i], close: c, volume: h.v[i] }));
  }

  toTime(t) {
    const tf = this.p.tf;
    if (tf === "1D" || tf === "1W") return vnDate(t);
    return t + VN; // hiển thị giờ Việt Nam
  }

  render(fit) {
    const c = this.colors();
    const bars = this.bars;
    const times = bars.map((b) => this.toTime(b.time));
    this.candle.setData(bars.map((b, i) => ({ time: times[i], open: b.open, high: b.high, low: b.low, close: b.close })));
    this.volume.setData(bars.map((b, i) => ({ time: times[i], value: b.volume, color: (b.close >= b.open ? c.up : c.down) + "66" })));
    const closes = bars.map((b) => b.close);
    const toLine = (arr) => arr.map((v, i) => (v == null ? { time: times[i] } : { time: times[i], value: v }));
    for (const o of OVERLAYS) {
      const s = this.lines[o.key];
      if (!s) continue;
      const r = o.calc(closes);
      if (o.key === "bb") { s[0].setData(toLine(r.upper)); s[1].setData(toLine(r.lower)); }
      else s.setData(toLine(r));
    }
    if (this.paneSeries.rsi) this.paneSeries.rsi.setData(toLine(ind.rsi(closes, 14)));
    if (this.paneSeries.macd) {
      const m = ind.macd(closes);
      this.paneSeries.macd.setData(toLine(m.line));
      this.paneSeries.macdSig.setData(toLine(m.signal));
      this.paneSeries.macdHist.setData(m.hist.map((v, i) => (v == null ? { time: times[i] } : { time: times[i], value: v, color: v >= 0 ? c.up + "99" : c.down + "99" })));
    }
    if (this.paneSeries.trix) {
      const t = ind.trix(closes, 3);
      this.paneSeries.trix.setData(toLine(t));
      this.paneSeries.trixSig.setData(toLine(ind.smaSeries(t, 6)));
    }
    if (this.paneSeries.asi) {
      const lim = LIMIT_PCT[store.meta[this.symbol]?.e] || 0.07;
      this.paneSeries.asi.setData(toLine(ind.asi(bars.map((b) => b.open), bars.map((b) => b.high), bars.map((b) => b.low), closes, lim)));
    }
    this.drawMarker(times);
    if (fit && bars.length && this.asOf && (this.p.tf === "1D" || this.p.tf === "1W")) {
      // backtest: hiển thị quanh ngày lọc
      const i = times.findIndex((t) => t >= this.asOf);
      if (i >= 0) this.chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, i - 90), to: Math.min(bars.length + 4, i + 40) });
      else this.chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, bars.length - 120), to: bars.length + 4 });
    } else if (fit && bars.length) {
      const n = bars.length;
      this.chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, n - 120), to: n + 4 });
    }
    this.quote();
    this.legend({});
  }

  quote() {
    const lv = store.live[this.symbol];
    const b = this.bars[this.bars.length - 1];
    const price = lv?.c ?? b?.close;
    const pc = lv?.pc ?? (this.p.tf === "1D" ? this.bars[this.bars.length - 2]?.close : null);
    const el = this.root.querySelector(".cp-price"), ch = this.root.querySelector(".cp-chg");
    el.textContent = price ? Math.round(price).toLocaleString("en-US") : "";
    if (price && pc) {
      const d = price - pc, pct = (d / pc) * 100;
      ch.textContent = `${d >= 0 ? "+" : ""}${Math.round(d).toLocaleString("en-US")} (${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%)`;
      ch.className = "cp-chg " + (d > 0 ? "up" : d < 0 ? "down" : "ref");
    } else ch.textContent = "";
  }

  legend(param) {
    const el = this.root.querySelector(".cp-legend");
    let d = param?.seriesData?.get(this.candle);
    if (!d && this.bars.length) {
      const b = this.bars[this.bars.length - 1];
      d = b;
    }
    if (!d) { el.innerHTML = ""; return; }
    const f = (x) => Math.round(x).toLocaleString("en-US");
    const vol = param?.seriesData?.get(this.volume)?.value ?? this.bars[this.bars.length - 1]?.volume;
    el.innerHTML = `O <b>${f(d.open)}</b> H <b>${f(d.high)}</b> L <b>${f(d.low)}</b> C <b>${f(d.close)}</b> V <b>${vol != null ? Number(vol).toLocaleString("en-US") : ""}</b>`;
  }

  msg(t) {
    const el = this.root.querySelector(".cp-msg");
    el.textContent = t;
    el.hidden = !t;
  }

  // Cập nhật nến mới nhất trong phiên
  startLive() {
    clearInterval(this.timer);
    this.timer = setInterval(async () => {
      if (!this.symbol || !isMarketOpen() || document.hidden) return;
      const seq = this.seq;
      const now = Math.floor(Date.now() / 1000);
      try {
        const fresh = await fetchOhlc(this.symbol, this.p.tf, now - (this.p.tf === "1W" ? 21 : 3) * 86400, now + 86400);
        if (seq !== this.seq || !fresh.length) return;
        const firstNew = fresh[0].time;
        this.bars = this.bars.filter((b) => b.time < firstNew).concat(fresh);
        this.render(false);
      } catch {}
    }, 10000);
  }

  // Ngày backtest ("YYYY-MM-DD") hoặc null
  setAsOf(day) {
    this.asOf = day;
    if (this.symbol) this.render(true);
  }

  drawMarker(times) {
    if (!this.markers) return;
    const daily = this.p.tf === "1D" || this.p.tf === "1W";
    if (!this.asOf || !daily) { this.markers.setMarkers([]); return; }
    // tuần: đánh dấu nến tuần chứa ngày lọc
    let t = times.filter((x) => x <= this.asOf).pop();
    if (!t) { this.markers.setMarkers([]); return; }
    this.markers.setMarkers([{ time: t, position: "belowBar", color: "#2962ff", shape: "arrowUp", text: "Ngày lọc" }]);
  }

  stop() {
    clearInterval(this.timer);
    this.symbol = null;
    this.seq++;
  }

  refreshTheme() {
    this.build();
    this.render(false);
  }
}
