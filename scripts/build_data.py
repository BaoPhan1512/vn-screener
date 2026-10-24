"""Tải dữ liệu cuối ngày cho bộ lọc cổ phiếu.

Chạy tự động trên GitHub Actions mỗi chiều (và mỗi lần cập nhật code).
Kết quả ghi vào thư mục --out:
  meta.json          danh sách mã: tên, sàn, số CP lưu hành, P/E, EPS, cổ tức
  history.json       ~260 nến ngày gần nhất của mỗi mã (c, h, l, v)

Nguồn:
  - Danh sách mã + chỉ số cơ bản: VNDirect Finfo (api-finfo.vndirect.com.vn)
  - Giá lịch sử: API biểu đồ công khai của DNSE (services.entrade.com.vn)

Nếu một nguồn lỗi, script dùng lại dữ liệu cũ (--prev) để website không bị trống.
Chỉ dùng thư viện chuẩn của Python, không cần cài thêm gì.
"""

import argparse
import json
import os
import sys
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

VN_TZ = timezone(timedelta(hours=7))
DNSE_CHART = "https://services.entrade.com.vn/chart-api/v2/ohlcs/stock"
FINFO_HOSTS = ["https://api-finfo.vndirect.com.vn", "https://finfo-api.vndirect.com.vn"]
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")
FINFO_HEADERS = {
    "User-Agent": UA,
    "Accept": "application/json, text/plain, */*",
    "Origin": "https://dstock.vndirect.com.vn",
    "Referer": "https://dstock.vndirect.com.vn/",
}
BARS = 260
FLOORS = ["HOSE", "HNX", "UPCOM"]


def log(*a):
    print(*a, flush=True)


def get_json(url, headers=None, retries=3, timeout=20):
    last = None
    for i in range(retries):
        try:
            req = urllib.request.Request(url, headers=headers or {"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.loads(r.read().decode("utf-8"))
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(1.5 * (i + 1))
    raise RuntimeError(f"{url}: {last}")


def finfo(path):
    last = None
    for host in FINFO_HOSTS:
        try:
            return get_json(host + path, FINFO_HEADERS)
        except Exception as e:  # noqa: BLE001
            last = e
    raise RuntimeError(last)


def load_prev(prev_dir, name):
    if not prev_dir:
        return None
    p = os.path.join(prev_dir, name)
    if os.path.exists(p):
        try:
            with open(p, encoding="utf-8") as f:
                return json.load(f)
        except Exception:  # noqa: BLE001
            return None
    return None


# ---------------------------------------------------------------- danh sách mã
def fetch_symbols():
    """Trả về dict symbol -> {n: tên, e: sàn}."""
    out = {}
    q = urllib.parse.quote("type:STOCK~status:LISTED")
    try:
        data = finfo(f"/v4/stocks?q={q}&size=5000")["data"]
        for d in data:
            code = str(d.get("code", "")).upper()
            floor = str(d.get("floor", "")).upper()
            if len(code) == 3 and floor in FLOORS:
                out[code] = {"n": d.get("shortName") or d.get("companyName") or code, "e": floor}
        log(f"[symbols] /v4/stocks: {len(out)} mã")
    except Exception as e:  # noqa: BLE001
        log(f"[symbols] /v4/stocks lỗi: {e}")
    if len(out) < 500:
        for floor in FLOORS:
            try:
                q = urllib.parse.quote(f"floor:{floor}")
                data = finfo(f"/v4/company_profiles?q={q}&size=2000")["data"]
                for d in data:
                    code = str(d.get("code", "")).upper()
                    if len(code) == 3 and code not in out:
                        out[code] = {"n": d.get("shortName") or d.get("companyName") or code, "e": floor}
            except Exception as e:  # noqa: BLE001
                log(f"[symbols] company_profiles {floor} lỗi: {e}")
        log(f"[symbols] sau khi bổ sung: {len(out)} mã")
    return out


# ---------------------------------------------------------------- giá lịch sử
def fetch_history(symbol, days=420):
    now = int(time.time())
    url = f"{DNSE_CHART}?symbol={symbol}&resolution=1D&from={now - days * 86400}&to={now + 86400}"
    d = get_json(url)
    t, c, h, l, v = d.get("t") or [], d.get("c") or [], d.get("h") or [], d.get("l") or [], d.get("v") or []
    rows = [(t[i], c[i], h[i], l[i], v[i]) for i in range(len(t)) if c[i] is not None]
    rows = rows[-BARS:]
    if not rows:
        return None
    # DNSE trả giá theo đơn vị nghìn đồng (vd 120.5) -> đổi sang đồng
    closes = sorted(r[1] for r in rows)
    mult = 1000 if closes[len(closes) // 2] < 1000 else 1
    last_date = datetime.fromtimestamp(rows[-1][0], VN_TZ).strftime("%Y-%m-%d")
    return {
        "d": last_date,
        "c": [round(r[1] * mult) for r in rows],
        "h": [round(r[2] * mult) for r in rows],
        "l": [round(r[3] * mult) for r in rows],
        "v": [int(r[4] or 0) for r in rows],
    }


# ---------------------------------------------------------------- chỉ số cơ bản
RATIOS = {"OUTSTANDING_SHARES": "sh", "PRICE_TO_EARNINGS": "pe", "DIVIDEND_YIELD": "dy"}


def fetch_ratios(symbol):
    out = {}
    for code, key in RATIOS.items():
        q = urllib.parse.quote(f"code:{symbol}~ratioCode:{code}")
        try:
            data = finfo(f"/v4/ratios?q={q}&sort=reportDate:desc&size=1")["data"]
            if data and data[0].get("value") is not None:
                out[key] = data[0]["value"]
        except Exception:  # noqa: BLE001
            pass
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--prev", help="thư mục chứa dữ liệu lần trước")
    ap.add_argument("--workers", type=int, default=8)
    ap.add_argument("--fundamentals-days", type=int, default=7,
                    help="bao nhiêu ngày thì tải lại chỉ số cơ bản")
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)

    prev_meta = load_prev(args.prev, "meta.json") or {}
    prev_hist = load_prev(args.prev, "history.json") or {}
    prev_syms = prev_meta.get("symbols", {})

    symbols = fetch_symbols()
    if len(symbols) < 300 and prev_syms:
        log("[symbols] nguồn lỗi, dùng danh sách cũ")
        symbols = {k: {"n": v.get("n", k), "e": v.get("e", "")} for k, v in prev_syms.items()}
    if not symbols:
        log("LỖI: không lấy được danh sách mã")
        sys.exit(1)

    # giá lịch sử
    hist, failed = {}, []

    def job(sym):
        try:
            return sym, fetch_history(sym)
        except Exception as e:  # noqa: BLE001
            return sym, e

    t0 = time.time()
    with ThreadPoolExecutor(args.workers) as ex:
        for i, (sym, res) in enumerate(ex.map(job, sorted(symbols))):
            if isinstance(res, dict):
                hist[sym] = res
            elif res is None:
                pass  # mã không có giao dịch
            else:
                failed.append(sym)
                if sym in prev_hist.get("data", {}):
                    hist[sym] = prev_hist["data"][sym]
            if i % 200 == 0:
                log(f"[history] {i}/{len(symbols)} ({time.time() - t0:.0f}s)")
    log(f"[history] xong {len(hist)} mã, lỗi {len(failed)}: {failed[:20]}")
    if len(hist) < 100:
        log("LỖI: lấy giá lịch sử thất bại (có thể nguồn DNSE chặn máy chủ nước ngoài)")
        if prev_hist.get("data"):
            hist = prev_hist["data"]
        else:
            sys.exit(1)

    # chỉ số cơ bản: tải lại định kỳ, các mã còn lại dùng dữ liệu cũ
    fund_age_ok = False
    if prev_meta.get("fundamentalsAt"):
        age = datetime.now(VN_TZ) - datetime.fromisoformat(prev_meta["fundamentalsAt"])
        fund_age_ok = age < timedelta(days=args.fundamentals_days)
    meta_syms = {}
    if fund_age_ok:
        log("[ratios] dùng lại dữ liệu cơ bản cũ")
        fundamentals_at = prev_meta["fundamentalsAt"]
        for sym in hist:
            meta_syms[sym] = dict(symbols.get(sym, {"n": sym, "e": ""}))
            for k in ("sh", "pe", "dy", "eps"):
                if k in prev_syms.get(sym, {}):
                    meta_syms[sym][k] = prev_syms[sym][k]
    else:
        log("[ratios] tải chỉ số cơ bản...")
        fundamentals_at = datetime.now(VN_TZ).isoformat(timespec="seconds")
        with ThreadPoolExecutor(args.workers) as ex:
            ratios = dict(zip(sorted(hist), ex.map(fetch_ratios, sorted(hist))))
        got = 0
        for sym in hist:
            m = dict(symbols.get(sym, {"n": sym, "e": ""}))
            r = ratios.get(sym) or {}
            if not r and sym in prev_syms:
                r = {k: prev_syms[sym][k] for k in ("sh", "pe", "dy") if k in prev_syms[sym]}
            m.update(r)
            pe = m.get("pe")
            if pe and pe > 0:
                m["eps"] = round(hist[sym]["c"][-1] / pe, 2)
            if r:
                got += 1
            meta_syms[sym] = m
        log(f"[ratios] có dữ liệu cho {got}/{len(hist)} mã")

    now = datetime.now(VN_TZ).isoformat(timespec="seconds")
    with open(os.path.join(args.out, "history.json"), "w", encoding="utf-8") as f:
        json.dump({"updatedAt": now, "data": hist}, f, separators=(",", ":"), ensure_ascii=False)
    with open(os.path.join(args.out, "meta.json"), "w", encoding="utf-8") as f:
        json.dump({"updatedAt": now, "fundamentalsAt": fundamentals_at, "symbols": meta_syms},
                  f, separators=(",", ":"), ensure_ascii=False)
    log(f"Hoàn tất: {len(hist)} mã -> {args.out}")


if __name__ == "__main__":
    main()
