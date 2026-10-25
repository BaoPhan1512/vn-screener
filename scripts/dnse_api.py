"""Gọi DNSE Lightspeed OpenAPI (nguồn dữ liệu chính thức).

Khoá lấy từ biến môi trường DNSE_API_KEY, DNSE_API_SECRET (GitHub Secrets).
Cách ký theo tài liệu https://developers.dnse.com.vn/docs/guide/intro/authentication
và SDK chính thức https://github.com/dnse-tech/openapi-sdk (python/dnse/api/common.py).
"""

import base64
import hashlib
import hmac
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from uuid import uuid4

BASE = os.environ.get("DNSE_API_BASE", "https://openapi.dnse.com.vn")
API_VERSION = os.environ.get("DNSE_API_VERSION", "2026-07-23")
# Tài liệu ghi header "X-Aux-Date", SDK mặc định "Date"; thử lần lượt
DATE_HEADERS = ["X-Aux-Date", "Date"]


def credentials():
    return os.environ.get("DNSE_API_KEY", ""), os.environ.get("DNSE_API_SECRET", "")


def enabled():
    k, s = credentials()
    return bool(k and s)


def date_value(now=None):
    return (now or datetime.now(timezone.utc)).strftime("%a, %d %b %Y %H:%M:%S +0000")


def sign(secret, method, path, date, nonce, header_name="Date"):
    """Trả về (headers_list, chữ ký đã URL-encode) giống hệt SDK chính thức."""
    key = header_name.lower()
    text = f"(request-target): {method.lower()} {path}\n{key}: {date}\nnonce: {nonce}"
    mac = hmac.new(secret.encode("utf-8"), text.encode("utf-8"), hashlib.sha256).digest()
    return f"(request-target) {key}", urllib.parse.quote(base64.b64encode(mac).decode(), safe="")


class DnseError(Exception):
    pass


_state = {"date_header": None}


def request(path, query=None, timeout=8):
    """GET có ký số. Trả về JSON. Tự chọn đúng tên header ngày ở lần gọi đầu."""
    api_key, secret = credentials()
    if not (api_key and secret):
        raise DnseError("Chưa có DNSE_API_KEY / DNSE_API_SECRET")
    url = BASE + path + ("?" + urllib.parse.urlencode(query) if query else "")
    candidates = [_state["date_header"]] if _state["date_header"] else DATE_HEADERS
    last = None
    for header_name in candidates:
        date, nonce = date_value(), uuid4().hex
        headers_list, signature = sign(secret, "GET", path, date, nonce, header_name)
        req = urllib.request.Request(url, method="GET")
        req.add_header(header_name, date)
        req.add_header("x-api-key", api_key)
        req.add_header("version", API_VERSION)
        req.add_header("X-Signature", f'Signature keyId="{api_key}",algorithm="hmac-sha256",'
                                      f'headers="{headers_list}",signature="{signature}",nonce="{nonce}"')
        req.add_header("Accept", "application/json")
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                _state["date_header"] = header_name
                return json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", "replace")[:300]
            last = DnseError(f"HTTP {e.code} {path}: {body}")
            # lỗi xác thực có thể do tên header ngày -> thử tên còn lại
            if e.code in (400, 401) and ("OA-400" in body or "Authorization" in body):
                continue
            raise last from None
        except Exception as e:  # noqa: BLE001
            raise DnseError(f"{path}: {e}") from None
    raise last


def instruments():
    """Danh sách cổ phiếu niêm yết: symbol -> {n, e}."""
    market = {"STO": "HOSE", "STX": "HNX", "UPX": "UPCOM"}
    out = {}
    for market_id, floor in market.items():
        page = 1
        while page < 50:
            d = request("/market/instruments", {"marketId": market_id, "securityGroupId": "ST",
                                                "limit": 500, "page": page})
            rows = d.get("data") or []
            for r in rows:
                sym = str(r.get("symbol", "")).upper()
                if len(sym) == 3 and sym.isalpha():
                    out[sym] = {"n": r.get("shortName") or r.get("name") or sym, "e": floor}
            total = d.get("total") or 0
            if not rows or page * (d.get("pageSize") or 500) >= total:
                break
            page += 1
            time.sleep(0.2)
    return out


def ohlc(symbol, resolution, frm, to, kind="STOCK"):
    """Nến OHLC: {t, o, h, l, c, v, nextTime} (cùng định dạng API biểu đồ của DNSE)."""
    return request("/price/ohlc", {"type": kind, "symbol": symbol, "resolution": resolution,
                                   "from": int(frm), "to": int(to)})
