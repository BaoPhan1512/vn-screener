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
from concurrent.futures import ThreadPoolExecutor, as_completed
from concurrent.futures import TimeoutError as FuturesTimeout
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
BARS = 330  # ~16 tháng: đủ cho SMA200 và backtest vài tháng
FLOORS = ["HOSE", "HNX", "UPCOM"]


def log(*a):
    print(*a, flush=True)


STATUS = {"sources": {}, "errors": []}


def note(source, ok, msg=""):
    st = STATUS["sources"].setdefault(source, {"ok": 0, "fail": 0, "lastError": ""})
    if ok:
        st["ok"] += 1
    else:
        st["fail"] += 1
        st["lastError"] = str(msg)[:300]


def write_status(out):
    try:
        os.makedirs(out, exist_ok=True)
        with open(os.path.join(out, "status.json"), "w", encoding="utf-8") as f:
            json.dump(STATUS, f, ensure_ascii=False, indent=1)
    except Exception:  # noqa: BLE001
        pass


def get_json(url, headers=None, retries=2, timeout=12):
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


FINFO_STATE = {"consecutive_fail": 0}


def finfo(path):
    # Ngắt sớm nếu VNDirect liên tục lỗi (vd chặn máy chủ nước ngoài) để không treo cả quy trình
    if FINFO_STATE["consecutive_fail"] >= 15:
        raise RuntimeError("VNDirect bị bỏ qua do lỗi liên tục")
    last = None
    for host in FINFO_HOSTS:
        try:
            d = get_json(host + path, FINFO_HEADERS)
            FINFO_STATE["consecutive_fail"] = 0
            note("vndirect", True)
            return d
        except Exception as e:  # noqa: BLE001
            last = e
    FINFO_STATE["consecutive_fail"] += 1
    note("vndirect", False, last)
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
        try:
            out.update({k: v for k, v in fetch_symbols_vci().items() if k not in out})
            log(f"[symbols] sau khi thêm nguồn Vietcap: {len(out)} mã")
        except Exception as e:  # noqa: BLE001
            log(f"[symbols] Vietcap lỗi: {e}")
            note("vietcap", False, e)
    if len(out) < 500:
        try:
            out.update({k: v for k, v in fetch_symbols_ssi().items() if k not in out})
            log(f"[symbols] sau khi thêm nguồn SSI: {len(out)} mã")
        except Exception as e:  # noqa: BLE001
            log(f"[symbols] SSI lỗi: {e}")
            note("ssi", False, e)
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


def fetch_symbols_vci():
    d = get_json("https://trading.vietcap.com.vn/api/price/symbols/getAll", {
        "User-Agent": UA, "Accept": "application/json",
        "Origin": "https://trading.vietcap.com.vn", "Referer": "https://trading.vietcap.com.vn/"})
    rows = d.get("data", d) if isinstance(d, dict) else d
    board_map = {"HSX": "HOSE", "HOSE": "HOSE", "HNX": "HNX", "UPCOM": "UPCOM"}
    out = {}
    for r in rows:
        code = str(r.get("symbol", "")).upper()
        floor = board_map.get(str(r.get("board", r.get("exchange", ""))).upper())
        typ = str(r.get("type", "STOCK")).upper()
        if len(code) == 3 and floor and typ == "STOCK":
            out[code] = {"n": r.get("organShortName") or r.get("organName") or code, "e": floor}
    note("vietcap", bool(out), "" if out else "rỗng")
    return out


def fetch_symbols_ssi():
    out = {}
    hdr = {"User-Agent": UA, "Accept": "application/json",
           "Origin": "https://iboard.ssi.com.vn", "Referer": "https://iboard.ssi.com.vn/"}
    for floor, path in (("HOSE", "hose"), ("HNX", "hnx"), ("UPCOM", "upcom")):
        d = get_json(f"https://iboard-query.ssi.com.vn/stock/exchange/{path}", hdr, retries=1)
        rows = d.get("data", d) if isinstance(d, dict) else d
        for r in rows or []:
            code = str(r.get("stockSymbol") or r.get("ss") or r.get("symbol") or "").upper()
            if len(code) == 3 and code.isalpha():
                out[code] = {"n": r.get("companyNameVi") or r.get("companyNameEn") or code, "e": floor}
    note("ssi", bool(out), "" if out else "rỗng")
    return out


# ---------------------------------------------------------------- giá lịch sử
HIST_STATE = {"via_worker": False}


def fetch_history(symbol, days=520, worker=None):
    now = int(time.time())
    q = f"symbol={symbol}&resolution=1D&from={now - days * 86400}&to={now + 86400}"
    if HIST_STATE["via_worker"] and worker:
        d = get_json(f"{worker}/ohlc?{q}")
    else:
        d = get_json(f"{DNSE_CHART}?{q}")
    t, c, h, l, v = d.get("t") or [], d.get("c") or [], d.get("h") or [], d.get("l") or [], d.get("v") or []
    o = d.get("o") or [None] * len(t)
    rows = [(t[i], c[i], h[i], l[i], v[i], o[i]) for i in range(len(t)) if c[i] is not None]
    rows = rows[-BARS:]
    if not rows:
        return None
    # DNSE trả giá theo đơn vị nghìn đồng (vd 120.5) -> đổi sang đồng
    closes = sorted(r[1] for r in rows)
    mult = 1000 if closes[len(closes) // 2] < 1000 else 1
    last_date = datetime.fromtimestamp(rows[-1][0], VN_TZ).strftime("%Y-%m-%d")
    # ngày giao dịch: số ngày kể từ 1/1/1970 (giờ VN), lưu dạng ngày đầu + khoảng cách
    days_vn = [int((r[0] + 7 * 3600) // 86400) for r in rows]
    return {
        "d": last_date,
        "t0": days_vn[0],
        "dt": [days_vn[i] - days_vn[i - 1] for i in range(1, len(days_vn))],
        "o": [round(r[5] * mult) if r[5] is not None else round(r[1] * mult) for r in rows],
        "c": [round(r[1] * mult) for r in rows],
        "h": [round(r[2] * mult) for r in rows],
        "l": [round(r[3] * mult) for r in rows],
        "v": [int(r[4] or 0) for r in rows],
    }


# ---------------------------------------------------------------- chỉ số cơ bản
RATIOS = {"OUTSTANDING_SHARES": "sh", "PRICE_TO_EARNINGS": "pe", "DIVIDEND_YIELD": "dy"}



# ---------------------------------------------------------------- dò nguồn dữ liệu
# Thử nhanh các nguồn miễn phí để biết nguồn nào truy cập được từ máy chủ đang chạy.
# Kết quả ghi vào status.json (mục "probes").
def _now():
    return int(time.time())


PROBES = {
    "dnse_chart": lambda: f"{DNSE_CHART}?symbol=FPT&resolution=1D&from={_now() - 10 * 86400}&to={_now()}",
    "vndirect_api_finfo": lambda: "https://api-finfo.vndirect.com.vn/v4/stocks?q=code:FPT",
    "vndirect_finfo_api": lambda: "https://finfo-api.vndirect.com.vn/v4/stocks?q=code:FPT",
    "vietcap_symbols": lambda: "https://trading.vietcap.com.vn/api/price/symbols/getAll",
    "ssi_stock": lambda: "https://iboard-query.ssi.com.vn/stock/FPT",
    "ssi_exchange": lambda: "https://iboard-query.ssi.com.vn/stock/exchange/hose",
    "cafef_ratio": lambda: ("https://cafef.vn/du-lieu/Ajax/PageNew/GetDataChiSoTaiChinh.ashx?Symbol=FPT"
                            "&TotalRow=1&EndDate=2026&ReportType=QUY&Sort=DESC"),
}
PROBE_HEADERS = {
    "vietcap_symbols": {"Origin": "https://trading.vietcap.com.vn", "Referer": "https://trading.vietcap.com.vn/"},
    "ssi_stock": {"Origin": "https://iboard.ssi.com.vn", "Referer": "https://iboard.ssi.com.vn/"},
    "ssi_exchange": {"Origin": "https://iboard.ssi.com.vn", "Referer": "https://iboard.ssi.com.vn/"},
    "cafef_ratio": {"Referer": "https://cafef.vn/"},
    "vndirect_api_finfo": FINFO_HEADERS,
    "vndirect_finfo_api": FINFO_HEADERS,
}


def _shape(o, depth=0):
    """Mô tả ngắn cấu trúc JSON (tên trường) để biết cách đọc dữ liệu."""
    if depth > 2:
        return "…"
    if isinstance(o, dict):
        return {k: _shape(v, depth + 1) for k, v in list(o.items())[:40]}
    if isinstance(o, list):
        return [_shape(o[0], depth + 1), f"({len(o)} phần tử)"] if o else []
    return o if isinstance(o, (int, float)) or o is None else str(o)[:40]


def probe_one(name):
    url = PROBES[name]()
    t0 = time.time()
    try:
        req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json",
                                                   **PROBE_HEADERS.get(name, {})})
        with urllib.request.urlopen(req, timeout=10) as r:
            body = r.read()
        res = {"ok": True, "status": 200, "ms": int((time.time() - t0) * 1000)}
        try:
            res["shape"] = _shape(json.loads(body.decode("utf-8")))
        except Exception:  # noqa: BLE001
            res["text"] = body[:200].decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        res = {"ok": False, "status": e.code, "ms": int((time.time() - t0) * 1000)}
    except Exception as e:  # noqa: BLE001
        res = {"ok": False, "error": str(e)[:200], "ms": int((time.time() - t0) * 1000)}
    return name, res


def run_probes():
    with ThreadPoolExecutor(len(PROBES)) as ex:
        STATUS["probes"] = dict(ex.map(probe_one, PROBES))
    for k, v in STATUS["probes"].items():
        log(f"[probe] {k}: {'OK' if v['ok'] else 'LỖI'} {v.get('status', '')} {v.get('error', '')} {v['ms']}ms")
    return STATUS["probes"]


# ---------------------------------------------------------------- chỉ số cơ bản dự phòng: CafeF + SSI
SSI_HEADERS = {"User-Agent": UA, "Accept": "application/json",
               "Origin": "https://iboard.ssi.com.vn", "Referer": "https://iboard.ssi.com.vn/"}


def fetch_ratios_alt(symbol):
    out = {}
    try:
        d = get_json(f"https://iboard-query.ssi.com.vn/stock/{symbol}", SSI_HEADERS, retries=1)
        sh = (d.get("data") or {}).get("listedShare")
        if sh:
            out["sh"] = sh
        note("ssi", True)
    except Exception as e:  # noqa: BLE001
        note("ssi", False, e)
    try:
        y = datetime.now(VN_TZ).year
        d = get_json(f"https://cafef.vn/du-lieu/Ajax/PageNew/GetDataChiSoTaiChinh.ashx?Symbol={symbol}"
                     f"&TotalRow=1&EndDate={y}&ReportType=QUY&Sort=DESC",
                     {"User-Agent": UA, "Referer": "https://cafef.vn/"}, retries=1)
        periods = ((d.get("Data") or {}).get("Value")) or []
        if periods:
            vals = {x.get("Code"): x.get("Value") for x in periods[0].get("Value") or []}
            if vals.get("EPS"):
                out["eps_raw"] = vals["EPS"] * 1000 if abs(vals["EPS"]) < 1000 else vals["EPS"]  # CafeF: nghìn đồng
            if vals.get("PE"):
                out["pe"] = vals["PE"]
        note("cafef", True)
    except Exception as e:  # noqa: BLE001
        note("cafef", False, e)
    return out


def fetch_ratios_bulk(symbols, chunk=100):
    """VNDirect: lấy chỉ số mới nhất cho 100 mã mỗi lần gọi."""
    out = {}
    codes = ",".join(RATIOS)
    for i in range(0, len(symbols), chunk):
        part = symbols[i:i + chunk]
        try:
            d = finfo(f"/v4/ratios/latest?filter=ratioCode:{codes}&where=code:{','.join(part)}"
                      f"&order=reportDate&fields=ratioCode,value,code")
            for r in d.get("data") or []:
                if r.get("value") is not None and r.get("ratioCode") in RATIOS:
                    out.setdefault(r["code"], {})[RATIOS[r["ratioCode"]]] = r["value"]
        except Exception as e:  # noqa: BLE001
            log(f"[ratios] lô {i // chunk} lỗi: {e}")
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--prev", help="thư mục chứa dữ liệu lần trước")
    ap.add_argument("--workers", type=int, default=12)
    ap.add_argument("--history-budget", type=float, default=15, help="số phút tối đa để tải giá lịch sử")
    ap.add_argument("--worker-url", default=os.environ.get("WORKER_URL", ""),
                    help="Cloudflare Worker dùng dự phòng khi DNSE chặn máy chủ GitHub")
    ap.add_argument("--fundamentals-days", type=int, default=7,
                    help="bao nhiêu ngày thì tải lại chỉ số cơ bản")
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)

    probes = run_probes()
    write_status(args.out)
    vnd_ok = probes["vndirect_api_finfo"]["ok"] or probes["vndirect_finfo_api"]["ok"]
    if not vnd_ok:
        FINFO_STATE["consecutive_fail"] = 999  # bỏ qua VNDirect ngay từ đầu
        log("[probe] VNDirect không truy cập được -> dùng nguồn dự phòng")

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

    worker = args.worker_url.rstrip("/")

    # Đo thử: gọi trực tiếp DNSE và gọi qua Worker, chọn đường nhanh + ổn định hơn
    def bench(via_worker, sample=("FPT", "VNM", "HPG", "SSI", "MWG", "ACB", "VCB", "PNJ")):
        ok, t0 = 0, time.time()
        for sym in sample:
            try:
                url = (f"{worker}/ohlc?" if via_worker else f"{DNSE_CHART}?") + \
                      f"symbol={sym}&resolution=1D&from={_now() - 30 * 86400}&to={_now()}"
                get_json(url, retries=1, timeout=10)
                ok += 1
            except Exception as e:  # noqa: BLE001
                note("worker" if via_worker else "dnse_direct", False, e)
        return {"ok": ok, "of": len(sample), "sec": round(time.time() - t0, 1)}

    direct = bench(False)
    STATUS["benchDirect"] = direct
    log(f"[history] đo DNSE trực tiếp: {direct}")
    if worker:
        via = bench(True)
        STATUS["benchWorker"] = via
        log(f"[history] đo qua Worker: {via}")
        if via["ok"] > direct["ok"] or (via["ok"] == direct["ok"] and via["sec"] < direct["sec"] * 0.7):
            HIST_STATE["via_worker"] = True
    log(f"[history] dùng {'Worker' if HIST_STATE['via_worker'] else 'DNSE trực tiếp'}")

    def job(sym):
        try:
            return sym, fetch_history(sym, worker=worker)
        except Exception as e:  # noqa: BLE001
            return sym, e

    # Tải song song, có giới hạn thời gian: hết giờ thì giữ phần đã tải + dữ liệu cũ
    t0 = time.time()
    deadline = t0 + args.history_budget * 60
    pending = sorted(symbols)
    recent = []
    ex = ThreadPoolExecutor(args.workers)
    futures = {ex.submit(job, sym): sym for sym in pending}
    done_count = 0
    no_data = set()
    try:
        for fut in as_completed(futures, timeout=max(1, deadline - time.time())):
            sym, res = fut.result()
            done_count += 1
            if isinstance(res, dict):
                hist[sym] = res
                recent.append(1)
            elif res is None:
                no_data.add(sym)  # mã không có giao dịch
                recent.append(1)
            else:
                failed.append(sym)
                recent.append(0)
            recent = recent[-100:]
            # lỗi nhiều khi gọi trực tiếp -> chuyển sang Worker cho phần còn lại
            if (not HIST_STATE["via_worker"] and worker and len(recent) >= 50
                    and sum(recent) / len(recent) < 0.7):
                HIST_STATE["via_worker"] = True
                log("[history] lỗi nhiều, chuyển sang Worker")
            if done_count % 200 == 0:
                log(f"[history] {done_count}/{len(pending)} ({time.time() - t0:.0f}s), lỗi {len(failed)}")
    except FuturesTimeout:
        log(f"[history] hết thời gian ({args.history_budget} phút), dừng ở {done_count}/{len(pending)}")
        STATUS["historyTimedOut"] = True
    ex.shutdown(wait=False, cancel_futures=True)

    # thử lại các mã lỗi (qua Worker nếu có) khi còn thời gian
    retry = [x for x in failed if x not in hist]
    if retry and worker and time.time() < deadline:
        HIST_STATE["via_worker"] = True
        log(f"[history] thử lại {len(retry)} mã qua Worker")
        with ThreadPoolExecutor(args.workers) as ex2:
            for sym, res in ex2.map(job, retry):
                if isinstance(res, dict):
                    hist[sym] = res
    for sym in pending:
        if sym not in hist and sym in prev_hist.get("data", {}):
            hist[sym] = prev_hist["data"][sym]
    failed = [x for x in pending if x not in hist and x not in no_data]
    STATUS["noData"] = len(no_data)
    STATUS["historySeconds"] = round(time.time() - t0)
    write_status(args.out)
    log(f"[history] xong {len(hist)} mã, lỗi {len(failed)}: {failed[:20]}")
    STATUS["history"] = {"symbols": len(hist), "failed": len(failed), "viaWorker": HIST_STATE["via_worker"]}
    STATUS["sampleFailed"] = failed[:30]
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
        ratios = fetch_ratios_bulk(sorted(hist)) if vnd_ok else {}
        STATUS["fundamentalsSource"] = "vndirect" if ratios else None
        missing = [x for x in sorted(hist) if x not in ratios]
        alt_ok = probes["cafef_ratio"]["ok"] or probes["ssi_stock"]["ok"]
        # bổ sung mã thiếu (hoặc toàn bộ nếu VNDirect lỗi) từ nguồn dự phòng
        if missing and alt_ok and (not ratios or len(missing) <= 600):
            log(f"[ratios] lấy bổ sung {len(missing)} mã từ CafeF + SSI")
            with ThreadPoolExecutor(args.workers) as ex:
                for sym, r in zip(missing, ex.map(fetch_ratios_alt, missing)):
                    if r:
                        ratios[sym] = r
            STATUS["fundamentalsSource"] = (STATUS["fundamentalsSource"] or "") + "+cafef/ssi"
        log(f"[ratios] nguồn: {STATUS['fundamentalsSource']}")
        got = 0
        for sym in hist:
            m = dict(symbols.get(sym, {"n": sym, "e": ""}))
            r = ratios.get(sym) or {}
            if not r and sym in prev_syms:
                r = {k: prev_syms[sym][k] for k in ("sh", "pe", "dy") if k in prev_syms[sym]}
            m.update(r)
            pe = m.get("pe")
            eps_raw = m.pop("eps_raw", None)
            if eps_raw and eps_raw > 0:
                m["eps"] = round(eps_raw, 2)
            elif pe and pe > 0:
                m["eps"] = round(hist[sym]["c"][-1] / pe, 2)
            if r:
                got += 1
            meta_syms[sym] = m
        log(f"[ratios] có dữ liệu cho {got}/{len(hist)} mã")
        if got == 0:
            fundamentals_at = None  # lỗi toàn bộ -> lần chạy sau thử lại

    now = datetime.now(VN_TZ).isoformat(timespec="seconds")
    with open(os.path.join(args.out, "history.json"), "w", encoding="utf-8") as f:
        json.dump({"updatedAt": now, "data": hist}, f, separators=(",", ":"), ensure_ascii=False)
    with open(os.path.join(args.out, "meta.json"), "w", encoding="utf-8") as f:
        json.dump({"updatedAt": now, "fundamentalsAt": fundamentals_at, "symbols": meta_syms},
                  f, separators=(",", ":"), ensure_ascii=False)
    STATUS["updatedAt"] = now
    STATUS["symbols"] = len(symbols)
    STATUS["withFundamentals"] = sum(1 for m in meta_syms.values() if "sh" in m)
    with open(os.path.join(args.out, "status.json"), "w", encoding="utf-8") as f:
        json.dump(STATUS, f, ensure_ascii=False, indent=1)
    log(f"Hoàn tất: {len(hist)} mã -> {args.out}")


if __name__ == "__main__":
    try:
        main()
    finally:
        # luôn ghi file chẩn đoán để kiểm tra nguồn nào lỗi
        out = next((sys.argv[i + 1] for i, x in enumerate(sys.argv[:-1]) if x == "--out"), None)
        if out and not os.path.exists(os.path.join(out, "status.json")):
            os.makedirs(out, exist_ok=True)
            with open(os.path.join(out, "status.json"), "w", encoding="utf-8") as f:
                json.dump(STATUS, f, ensure_ascii=False, indent=1)
