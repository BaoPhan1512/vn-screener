// Kiểm tra kết nối DNSE Lightspeed OpenAPI (chạy bằng tay trong tab Actions).
// Kết quả hiện ở mục Annotations: ✅ thành công / ❌ lỗi kèm lý do. Không in khoá ra ngoài.
//   1. Worker: có khoá DNSE chưa, có khoá mật khẩu không
//   2. REST qua Worker: nến ngày FPT (Worker ký số bằng khoá trong Cloudflare)
//   3. WebSocket: lấy vé từ Worker, kết nối DNSE, xác thực, đăng ký nến ngày FPT/HPG/VNM
const WORKER = (process.env.WORKER_URL || "").replace(/\/+$/, "");
const KEY = process.env.WORKER_KEY || "";
const note = (level, msg) => console.log(`::${level}::${msg}`);
const ok = (msg) => note("notice", "✅ " + msg);
const bad = (msg) => note("error", "❌ " + msg);
const hdr = KEY ? { "X-Access-Key": KEY } : {};

async function main() {
  // 1. Worker
  let info;
  try {
    info = await (await fetch(WORKER + "/")).json();
  } catch (e) {
    return bad(`Không mở được Worker ${WORKER}: ${e.message}`);
  }
  if (!info.version || info.version < 5) return bad("Worker đang chạy code cũ: hãy dán lại code worker/worker.js mới nhất rồi Deploy");
  if (!info.official) return bad("Worker chưa có khoá DNSE: thêm 2 Secret DNSE_API_KEY và DNSE_API_SECRET trong Cloudflare (Settings → Variables and Secrets)");
  ok(`Worker phiên bản ${info.version}, đã có khoá DNSE${info.locked ? ", đã khoá mật khẩu" : ""}`);

  // 2. REST
  const now = Math.floor(Date.now() / 1000);
  try {
    const r = await fetch(`${WORKER}/ohlc?symbol=FPT&resolution=1D&from=${now - 20 * 86400}&to=${now}`, { headers: hdr });
    const d = await r.json();
    const after = await (await fetch(WORKER + "/")).json();
    if (r.status === 401) bad("Worker từ chối mật khẩu: secret WORKER_KEY trên GitHub phải giống ACCESS_KEY trên Cloudflare");
    else if (r.ok && d.t && after.restOfficial === false) note("warning", `⚠️ REST chính thức không truy cập được từ Cloudflare (${after.restError || "hết thời gian chờ"}): biểu đồ và Telegram đang tự dùng nguồn cũ. FPT có ${d.t.length} nến.`);
    else if (!r.ok || !d.t) bad(`API OHLC chính thức lỗi (HTTP ${r.status}): ${JSON.stringify(d).slice(0, 300)}`);
    else ok(`API OHLC chính thức: FPT có ${d.t.length} nến ngày, giá đóng cửa gần nhất ${d.c.at(-1)}`);
  } catch (e) {
    bad("Gọi API OHLC lỗi: " + e.message);
  }

  // 3. WebSocket
  let t;
  try {
    const r = await fetch(`${WORKER}/ws-auth`, { headers: hdr });
    t = await r.json();
    if (!r.ok) return bad(`Không lấy được vé WebSocket (HTTP ${r.status}): ${JSON.stringify(t).slice(0, 200)}`);
  } catch (e) {
    return bad("Không lấy được vé WebSocket: " + e.message);
  }
  await new Promise((resolve) => {
    const ws = new WebSocket(t.url);
    let step = "kết nối", bars = 0, first = true;
    const done = (fn, msg) => { fn(msg); clearTimeout(timer); try { ws.close(); } catch {} resolve(); };
    const timer = setTimeout(() => {
      if (step === "đã đăng ký") done(ok, `WebSocket chạy tốt: xác thực OK, đăng ký OK, nhận ${bars} bản tin nến trong 20 giây${bars ? "" : " (ngoài giờ giao dịch thì không có bản tin là bình thường)"}`);
      else done(bad, `WebSocket dừng ở bước "${step}" sau 20 giây`);
    }, 20000);
    ws.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      const a = m.action || m.a;
      if (first) { first = false; step = "xác thực"; ws.send(JSON.stringify(t.auth)); return; }
      if (a === "auth_success") {
        step = "đăng ký";
        ws.send(JSON.stringify({ action: "subscribe", channels: [{ name: "ohlc.1D.json", symbols: ["FPT", "HPG", "VNM"] }] }));
      } else if (a === "auth_error" || (a === "error" && step !== "đã đăng ký")) {
        done(bad, `WebSocket bị từ chối ở bước ${step}: ${m.message || m.msg || JSON.stringify(m).slice(0, 200)}`);
      } else if (a === "subscribed") {
        step = "đã đăng ký";
      } else if (a === "ping") {
        ws.send(JSON.stringify({ action: "pong" }));
      } else if (m.T === "b" || m.T === "bc") {
        bars++;
        if (step === "đăng ký") step = "đã đăng ký";
      }
    };
    ws.onerror = () => { if (step === "kết nối") done(bad, "Không kết nối được WebSocket " + t.url); };
  });
}

main().catch((e) => bad(e.message));
