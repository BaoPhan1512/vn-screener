// Cloudflare Worker: cầu nối giữa website và API biểu đồ công khai của DNSE.
// Trình duyệt không gọi thẳng được API của DNSE (bị chặn CORS), nên đi qua đây.
//
// Cách cài: Cloudflare > Workers & Pages > Create > "Hello World" > Edit code,
// xoá hết, dán toàn bộ file này vào, bấm Deploy.
//
// Khoá bằng mật khẩu: Worker > Settings > Variables and Secrets > Add > Type "Secret",
// tên ACCESS_KEY, giá trị là mật khẩu bạn chọn. Mọi yêu cầu phải gửi kèm header
// "X-Access-Key: <mật khẩu>", nếu sai sẽ bị từ chối (401). Chưa đặt ACCESS_KEY thì Worker mở tự do.
//
//   GET /ohlc?symbol=FPT&resolution=5&from=...&to=...[&kind=index]
//       -> nến (định dạng t,o,h,l,c,v của DNSE)
//   GET /snapshot?symbols=FPT,VNM,...  (tối đa 45 mã / lần)
//       -> nến ngày hôm nay + giá đóng cửa hôm trước của từng mã
//   GET /board?ex=hose|hnx|upcom
//       -> bảng giá cả sàn trong 1 lần gọi (nguồn SSI iBoard), giá theo đồng

const DNSE = "https://services.entrade.com.vn/chart-api/v2/ohlcs";
const SSI_BOARD = "https://iboard-query.ssi.com.vn/stock/exchange";
const MAX_SYMBOLS = 45; // gói miễn phí giới hạn 50 request con mỗi lượt
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "X-Access-Key, Content-Type",
};

function json(body, status = 200, maxAge = 0) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...CORS,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": maxAge ? `public, max-age=${maxAge}` : "no-store",
    },
  });
}

async function dnse(kind, symbol, resolution, from, to) {
  const url = `${DNSE}/${kind}?symbol=${encodeURIComponent(symbol)}&resolution=${encodeURIComponent(resolution)}&from=${from}&to=${to}`;
  const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
  if (!r.ok) throw new Error(`DNSE ${r.status}`);
  return r.json();
}

async function handleOhlc(params) {
  const symbol = (params.get("symbol") || "").toUpperCase();
  if (!/^[A-Z0-9]{2,12}$/.test(symbol)) return json({ error: "symbol không hợp lệ" }, 400);
  const kind = params.get("kind") === "index" ? "index" : "stock";
  const now = Math.floor(Date.now() / 1000);
  const resolution = params.get("resolution") || "1D";
  const from = parseInt(params.get("from")) || now - 365 * 86400;
  const to = parseInt(params.get("to")) || now + 86400;
  const data = await dnse(kind, symbol, resolution, from, to);
  return json(data, 200, 5);
}

async function handleSnapshot(params) {
  const symbols = [...new Set((params.get("symbols") || "").toUpperCase().split(",").filter((s) => /^[A-Z0-9]{2,12}$/.test(s)))]
    .slice(0, MAX_SYMBOLS);
  const now = Math.floor(Date.now() / 1000);
  const out = {};
  await Promise.all(
    symbols.map(async (s) => {
      try {
        const d = await dnse("stock", s, "1D", now - 12 * 86400, now + 86400);
        const n = d.t ? d.t.length : 0;
        if (!n) return;
        const i = n - 1;
        out[s] = { t: d.t[i], o: d.o[i], h: d.h[i], l: d.l[i], c: d.c[i], v: d.v[i], pc: n > 1 ? d.c[i - 1] : null };
      } catch (e) {
        out[s] = { error: String(e.message || e) };
      }
    })
  );
  return json({ time: now, data: out }, 200, 3);
}

async function handleBoard(params) {
  const ex = (params.get("ex") || "").toLowerCase();
  if (!["hose", "hnx", "upcom"].includes(ex)) return json({ error: "ex phải là hose, hnx hoặc upcom" }, 400);
  const r = await fetch(`${SSI_BOARD}/${ex}`, {
    headers: { "User-Agent": UA, Accept: "application/json", Origin: "https://iboard.ssi.com.vn", Referer: "https://iboard.ssi.com.vn/" },
  });
  if (!r.ok) throw new Error(`SSI ${r.status}`);
  const d = await r.json();
  // Rút gọn: chỉ giữ cổ phiếu (bỏ chứng quyền, ETF...) và các trường cần thiết
  const rows = (d.data || [])
    .filter((x) => x.stockType === "s" && /^[A-Z]{3}$/.test(x.stockSymbol || ""))
    .map((x) => ({
      s: x.stockSymbol,
      d: x.tradingDate,
      c: x.matchedPrice || 0,
      o: x.openPrice || 0,
      h: x.highest || 0,
      l: x.lowest || 0,
      v: x.nmTotalTradedQty || 0,
      r: x.refPrice || x.priorClosePrice || 0,
      ce: x.ceiling || 0,
      fl: x.floor || 0,
      n: x.companyNameVi || "",
    }));
  return json({ time: Math.floor(Date.now() / 1000), ex, data: rows }, 200, 3);
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    const url = new URL(request.url);

    // Trang gốc chỉ báo trạng thái (không chứa dữ liệu) nên không cần mật khẩu
    if (url.pathname === "/") {
      return json({ ok: true, version: 3, locked: !!env.ACCESS_KEY, routes: ["/ohlc", "/snapshot", "/board"] });
    }
    if (env.ACCESS_KEY && request.headers.get("X-Access-Key") !== env.ACCESS_KEY) {
      return json({ error: "Sai hoặc thiếu mật khẩu (X-Access-Key)" }, 401);
    }

    // Cache ngắn hạn để nhiều người mở web cùng lúc không gọi DNSE quá nhiều
    const cache = caches.default;
    const cached = await cache.match(request);
    if (cached) return cached;

    let res;
    try {
      if (url.pathname === "/ohlc") res = await handleOhlc(url.searchParams);
      else if (url.pathname === "/snapshot") res = await handleSnapshot(url.searchParams);
      else if (url.pathname === "/board") res = await handleBoard(url.searchParams);
      else return json({ error: "Không có đường dẫn này" }, 404);
    } catch (e) {
      return json({ error: String(e.message || e) }, 502);
    }
    if (res.status === 200) ctx.waitUntil(cache.put(request, res.clone()));
    return res;
  },
};
