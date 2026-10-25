// Cloudflare Worker: cầu nối giữa website và dữ liệu giá của DNSE.
// Trình duyệt không gọi thẳng được API của DNSE (bị chặn CORS), nên đi qua đây.
//
// Nguồn chính thức (DNSE Lightspeed OpenAPI): thêm 2 Secret DNSE_API_KEY và DNSE_API_SECRET
// (Settings > Variables and Secrets). Có khoá thì Worker dùng API chính thức và ký số HMAC,
// khoá bí mật chỉ nằm trong Cloudflare. Chưa có khoá thì dùng API biểu đồ công khai như cũ.
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
//   GET /ws-auth
//       -> "vé" xác thực WebSocket realtime của DNSE (ký sẵn, hết hạn sau ít phút),
//          để trình duyệt tự kết nối wss://ws-openapi.dnse.com.vn mà không cần biết khoá bí mật

const DNSE = "https://services.entrade.com.vn/chart-api/v2/ohlcs";
const OPENAPI = "https://openapi.dnse.com.vn";
const OPENAPI_VERSION = "2026-07-23";
const OPENAPI_WS = "wss://ws-openapi.dnse.com.vn/v1/stream?encoding=json";
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

// ---------------------------------------------------------------- DNSE OpenAPI (chính thức)
const enc = new TextEncoder();
async function hmac(secret, text) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(text)));
}
const toBase64 = (bytes) => btoa(String.fromCharCode(...bytes));
const toHex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
const newNonce = () => crypto.randomUUID().replace(/-/g, "");
const httpDate = () => new Date().toUTCString().replace("GMT", "+0000");

// Chữ ký REST theo tài liệu DNSE: HMAC-SHA256("(request-target): get <path>\n<date-header>: <date>\nnonce: <nonce>")
async function signRest(secret, method, path, date, nonce, headerName = "Date") {
  const key = headerName.toLowerCase();
  const text = `(request-target): ${method.toLowerCase()} ${path}\n${key}: ${date}\nnonce: ${nonce}`;
  return { headers: `(request-target) ${key}`, signature: encodeURIComponent(toBase64(await hmac(secret, text))) };
}

// Chữ ký WebSocket: hex HMAC-SHA256("<api_key>:<timestamp>:<nonce>")
async function signWs(apiKey, secret, timestamp, nonce) {
  return toHex(await hmac(secret, `${apiKey}:${timestamp}:${nonce}`));
}

let dateHeaderName = null; // tài liệu ghi "X-Aux-Date", SDK dùng "Date": thử cả hai, nhớ cái dùng được
async function openapi(env, path, query) {
  const url = `${env.DNSE_API_BASE || OPENAPI}${path}?${new URLSearchParams(query)}`;
  let last;
  for (const name of dateHeaderName ? [dateHeaderName] : ["X-Aux-Date", "Date"]) {
    const date = httpDate(), nonce = newNonce();
    const sig = await signRest(env.DNSE_API_SECRET, "GET", path, date, nonce, name);
    const r = await fetch(url, {
      headers: {
        [name]: date,
        "x-api-key": env.DNSE_API_KEY,
        version: OPENAPI_VERSION,
        Accept: "application/json",
        "X-Signature": `Signature keyId="${env.DNSE_API_KEY}",algorithm="hmac-sha256",headers="${sig.headers}",signature="${sig.signature}",nonce="${nonce}"`,
      },
    });
    if (r.ok) { dateHeaderName = name; return r.json(); }
    const body = (await r.text()).slice(0, 300);
    last = new Error(`DNSE OpenAPI ${r.status}: ${body}`);
    if (!(r.status === 400 || r.status === 401) || !/OA-400|Authorization/.test(body)) break;
  }
  throw last;
}

const official = (env) => !!(env.DNSE_API_KEY && env.DNSE_API_SECRET);
const RES_MAP = { "1H": "1h" }; // API chính thức dùng "1h"

async function dnse(kind, symbol, resolution, from, to, env) {
  if (env && official(env)) {
    return openapi(env, "/price/ohlc", { type: kind === "index" ? "INDEX" : "STOCK", symbol, resolution: RES_MAP[resolution] || resolution, from, to });
  }
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
  const data = await dnse(kind, symbol, resolution, from, to, ENV);
  return json(data, 200, 5);
}

async function handleWsAuth(env) {
  if (!official(env)) return json({ error: "Chưa cài DNSE_API_KEY / DNSE_API_SECRET" }, 404);
  const timestamp = Math.floor(Date.now() / 1000);
  const nonce = String(Date.now() * 1000 + Math.floor(Math.random() * 1000));
  const signature = await signWs(env.DNSE_API_KEY, env.DNSE_API_SECRET, timestamp, nonce);
  return json({ url: env.DNSE_WS_URL || OPENAPI_WS, auth: { action: "auth", api_key: env.DNSE_API_KEY, signature, timestamp, nonce } });
}

async function handleSnapshot(params) {
  const symbols = [...new Set((params.get("symbols") || "").toUpperCase().split(",").filter((s) => /^[A-Z0-9]{2,12}$/.test(s)))]
    .slice(0, MAX_SYMBOLS);
  const now = Math.floor(Date.now() / 1000);
  const out = {};
  await Promise.all(
    symbols.map(async (s) => {
      try {
        const d = await dnse("stock", s, "1D", now - 12 * 86400, now + 86400, ENV);
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

let ENV = null;

export default {
  async fetch(request, env, ctx) {
    ENV = env;
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    const url = new URL(request.url);

    // Trang gốc chỉ báo trạng thái (không chứa dữ liệu) nên không cần mật khẩu
    if (url.pathname === "/") {
      return json({ ok: true, version: 4, locked: !!env.ACCESS_KEY, official: official(env), routes: ["/ohlc", "/snapshot", "/board", "/ws-auth"] });
    }
    if (env.ACCESS_KEY && request.headers.get("X-Access-Key") !== env.ACCESS_KEY) {
      return json({ error: "Sai hoặc thiếu mật khẩu (X-Access-Key)" }, 401);
    }

    if (url.pathname === "/ws-auth") return handleWsAuth(env); // không cache: mỗi vé chỉ dùng một lần

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
