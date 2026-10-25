// Giá realtime qua WebSocket chính thức của DNSE (Lightspeed OpenAPI).
// Trình duyệt xin Worker một "vé" xác thực đã ký sẵn (/ws-auth) rồi tự kết nối tới DNSE,
// nên khoá bí mật API không bao giờ nằm trong trình duyệt.
// Kênh dùng: ohlc.1D.json -> nến ngày đang hình thành của từng mã (T = "b").
import { store, settings } from "./data.js";

const PER_CONN = 200; // giới hạn của DNSE: 200 mã / kết nối
const MAX_CONN = 3; // tối đa 10 kết nối / tài khoản -> mỗi thiết bị dùng tối đa 3
const CHANNEL = "ohlc.1D.json";

export const stream = {
  state: "off", // off | connecting | live | unavailable
  error: "",
  lastMsgAt: null,
  conns: [],
  onUpdate: null,
};

async function ticket() {
  const s = settings();
  const r = await fetch(`${s.workerUrl}/ws-auth`, s.accessKey ? { headers: { "X-Access-Key": s.accessKey } } : undefined);
  if (r.status === 404) throw Object.assign(new Error("Worker chưa có khoá DNSE OpenAPI"), { permanent: true });
  if (!r.ok) throw new Error("Không lấy được vé WebSocket (HTTP " + r.status + ")");
  return r.json();
}

function priceScale(sym, close) {
  // DNSE trả giá theo nghìn đồng; ước lượng bằng cách so với giá đóng cửa gần nhất trong lịch sử
  if (store.scale != null) return store.scale;
  const h = store.history[sym];
  if (h && h.c.length && close) store.scale = h.c[h.c.length - 1] / close > 100 ? 1000 : 1;
  return store.scale ?? 1000;
}

function onBar(d) {
  const sym = d.symbol;
  if (!sym || d.close == null) return;
  const k = priceScale(sym, d.close);
  let t = Number(d.time) || Math.floor(Date.now() / 1000);
  if (t > 1e12) t = Math.floor(t / 1000);
  const h = store.history[sym];
  const prev = store.live[sym];
  store.live[sym] = {
    t,
    o: d.open * k,
    h: d.high * k,
    l: d.low * k,
    c: d.close * k,
    v: Number(d.volume) || 0,
    pc: prev?.pc ?? (h ? h.c[h.c.length - 1] : null),
    ce: prev?.ce,
    fl: prev?.fl,
  };
}

class Conn {
  constructor(symbols) {
    this.symbols = symbols;
    this.closed = false;
    this.retry = 0;
    this.open();
  }

  async open() {
    if (this.closed) return;
    let t;
    try {
      t = await ticket();
    } catch (e) {
      stream.error = e.message;
      if (e.permanent) { stream.state = "unavailable"; return; }
      return this.again();
    }
    const ws = (this.ws = new WebSocket(t.url));
    let authed = false, welcomed = false;
    ws.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      const action = m.action || m.a;
      // Giống SDK chính thức: tin nhắn đầu tiên là lời chào -> gửi vé xác thực
      if (!welcomed) {
        welcomed = true;
        ws.send(JSON.stringify(t.auth));
        return;
      }
      if (action === "auth_success") {
        authed = true;
        this.retry = 0;
        stream.state = "live";
        stream.error = "";
        ws.send(JSON.stringify({ action: "subscribe", channels: [{ name: CHANNEL, symbols: this.symbols }] }));
        return;
      }
      if (action === "auth_error" || action === "error") {
        stream.error = "DNSE: " + (m.message || m.msg || action);
        return;
      }
      if (action === "ping") { ws.send(JSON.stringify({ action: "pong" })); return; }
      if (m.T === "b" || m.T === "bc") {
        onBar(m);
        stream.lastMsgAt = new Date();
        stream.onUpdate?.();
      }
    };
    ws.onclose = () => { if (!this.closed) this.again(); };
    ws.onerror = () => { stream.error = stream.error || "Mất kết nối WebSocket"; };
    // Chủ động gửi pong để giữ kết nối (DNSE ngắt nếu im lặng quá lâu)
    clearInterval(this.keep);
    this.keep = setInterval(() => { if (ws.readyState === 1) ws.send(JSON.stringify({ action: "pong" })); }, 120000);
  }

  again() {
    if (this.closed) return;
    this.retry++;
    if (this.retry >= 4 && stream.state !== "live") stream.state = "unavailable";
    setTimeout(() => this.open(), Math.min(60000, 2000 * 2 ** this.retry));
  }

  close() {
    this.closed = true;
    clearInterval(this.keep);
    try { this.ws?.close(); } catch {}
  }
}

// Mở (hoặc mở lại) kết nối cho danh sách mã; danh sách đã sắp theo mức độ ưu tiên
export function startStream(symbols) {
  // Không dùng được (vd Worker chưa có khoá): 10 phút sau mới thử lại
  if (stream.state === "unavailable" && Date.now() - (stream.unavailableAt ||= Date.now()) < 600000) return;
  stream.unavailableAt = 0;
  const want = symbols.slice(0, PER_CONN * MAX_CONN);
  const key = want.join(",");
  if (stream.key === key && stream.conns.length && stream.state !== "unavailable") return;
  stopStream();
  stream.key = key;
  stream.state = "connecting";
  for (let i = 0; i < want.length; i += PER_CONN) stream.conns.push(new Conn(want.slice(i, i + PER_CONN)));
}

export function stopStream() {
  for (const c of stream.conns) c.close();
  stream.conns = [];
  stream.key = "";
  if (stream.state !== "unavailable") stream.state = "off";
}
