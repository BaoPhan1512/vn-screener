# Bộ lọc cổ phiếu VN (realtime)

Website lọc cổ phiếu Việt Nam theo điều kiện kỹ thuật, tương tự TradingView Screener. Hoàn toàn miễn phí:
chạy trên **GitHub Pages**, lấy dữ liệu qua **Cloudflare Workers** (gói miễn phí).

## Tính năng

- Điều kiện lọc dạng "chip" như TradingView: `Giá cắt lên ↗ SMA 20`, `EMA 2 > EMA 5`, `KL > 50K`, `Vốn hoá > 1T`…
- So sánh chỉ báo với chỉ báo hoặc với một con số; toán tử `> ≥ < ≤`, **cắt lên**, **cắt xuống**, **trong khoảng**, **hướng lên**, **hướng xuống**
- Chỉ báo: SMA, EMA, RSI, MACD, TRIX + MA(TRIX), ASI, Bollinger, ATR, đỉnh/đáy N phiên, đỉnh/đáy 52 tuần, KL trung bình, KL tương đối, hiệu suất…
- Cơ bản: vốn hoá, P/E, EPS, tỷ suất cổ tức
- Cập nhật realtime trong giờ giao dịch (mặc định 15 giây/lần), nhấp nháy khi giá đổi, gắn nhãn **MỚI** cho mã vừa lọt vào bộ lọc, có thể bật thông báo
- Bấm vào mã để mở biểu đồ nến (1m, 5m, 15m, 1H, 1D, 1W) với MA, EMA, Bollinger, RSI, MACD, khối lượng; dùng phím ↑/↓ để chuyển mã
- **Backtest**: nút 📅 chọn một ngày trong quá khứ (dữ liệu ~16 tháng), lọc như tại ngày đó và xem lợi nhuận sau 1, 3, 5, 10, 20 phiên, tỷ lệ mã tăng
- Lưu nhiều bộ lọc, có sẵn các mẫu, chia sẻ bộ lọc bằng link, danh sách theo dõi ★, giao diện sáng/tối, dùng được trên điện thoại

## Kiến trúc

```
GitHub Actions (16:20 thứ 2-6) ── DNSE OpenAPI: danh sách mã + 330 nến ngày; VNDirect: chỉ số cơ bản ──► data/*.json
GitHub Pages ── website tĩnh: tính chỉ báo & lọc ngay trong trình duyệt
Cloudflare Worker ── giữ khoá DNSE OpenAPI, ký số các yêu cầu, cấp "vé" WebSocket
Trình duyệt ── kết nối thẳng WebSocket chính thức của DNSE để nhận giá realtime
```

| Thư mục | Nội dung |
|---|---|
| `web/` | Website (Vite + JavaScript, biểu đồ TradingView Lightweight Charts) |
| `worker/worker.js` | Mã Cloudflare Worker (dán vào Cloudflare) |
| `scripts/build_data.py` | Script tải dữ liệu cuối ngày (chạy tự động trên GitHub) |
| `.github/workflows/deploy.yml` | Lịch chạy tự động: tải dữ liệu, build, đưa web lên mạng |

## Cài đặt (làm một lần)

### 1. Bật GitHub Pages
Vào repo trên GitHub → **Settings** → **Pages** → mục *Source* chọn **GitHub Actions**.
Sau đó vào tab **Actions** → chọn "Cập nhật dữ liệu & website" → **Run workflow**.
Khoảng 5–15 phút sau, website có ở địa chỉ `https://<tên-github>.github.io/<tên-repo>/`.

### 2. Tạo Cloudflare Worker (để có giá realtime)
1. Đăng ký miễn phí tại https://dash.cloudflare.com/sign-up (không cần thẻ).
2. Menu trái **Compute (Workers)** → **Workers & Pages** → **Create** → chọn **Start with Hello World** → đặt tên `vn-proxy` → **Deploy**.
3. Bấm **Edit code**, xoá hết nội dung, dán toàn bộ file `worker/worker.js` vào → **Deploy**.
4. Sao chép địa chỉ dạng `https://vn-proxy.<tên-bạn>.workers.dev`.
5. Mở website → biểu tượng ⚙ **Cài đặt** → dán địa chỉ vào ô *Địa chỉ Cloudflare Worker* → **Lưu**.
   (Hoặc ghi vào `web/src/config.js` để áp dụng cho mọi trình duyệt.)

Kiểm tra Worker: mở `https://vn-proxy.<tên-bạn>.workers.dev/` sẽ thấy `"ok":true`.

**Khoá Worker bằng mật khẩu** (chỉ bạn dùng được):
1. Cloudflare → Worker `vn-proxy` → **Settings** → **Variables and Secrets** → **Add** → Type **Secret**, Name `ACCESS_KEY`, Value = mật khẩu → **Deploy**.
2. GitHub → **Settings** → **Secrets and variables** → **Actions** → secret `WORKER_KEY` = cùng mật khẩu (cho dữ liệu cuối ngày và Telegram).
3. Trên mỗi trình duyệt/app: ⚙ **Cài đặt** → **Mật khẩu Worker** → nhập mật khẩu → **Lưu**.

### 2b. Dùng nguồn dữ liệu chính thức DNSE Lightspeed OpenAPI
1. Đăng ký Lightspeed API trên https://entradex.dnse.com.vn (Thông tin tài khoản → LightSpeed API) → nhận **API Key** và **API Secret**.
2. Cloudflare → Worker `vn-proxy` → **Settings** → **Variables and Secrets**: thêm 2 Secret `DNSE_API_KEY`, `DNSE_API_SECRET`.
3. GitHub → **Settings** → **Secrets and variables** → **Actions**: thêm 2 secret cùng tên (cho dữ liệu cuối ngày).
4. Tab **Actions** → "Kiểm tra API DNSE" → **Run workflow** → xem kết quả ở mục Annotations.

Điều khoản DNSE (mục 2đ): dữ liệu chỉ dùng cho mục đích giao dịch của chính chủ tài khoản, không cung cấp cho bên thứ ba.

### 3. Nhận tín hiệu qua Telegram (tuỳ chọn)
GitHub tự lọc và gửi kết quả vào Telegram mỗi 30 phút từ 9:00 đến 15:00, bỏ giờ nghỉ trưa (thứ 2–6, ngày lễ tự bỏ qua; GitHub có thể trễ vài phút).
1. Trong Telegram, nhắn cho **@BotFather** lệnh `/newbot`, đặt tên → nhận **token** (dạng `123456:ABC...`).
2. Nhắn một tin bất kỳ (vd `hi`) cho bot vừa tạo.
3. Mở `https://api.telegram.org/bot<TOKEN>/getUpdates` → tìm `"chat":{"id":123456789` → đó là **chat id**.
4. Repo GitHub → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**:
   `TELEGRAM_BOT_TOKEN` = token, `TELEGRAM_CHAT_ID` = chat id (nhiều người nhận: các id cách nhau bằng dấu phẩy, hoặc dùng id của nhóm).
5. Thử: tab **Actions** → "Tín hiệu Telegram" → **Run workflow** (tick "Gửi thử").

Bộ lọc được gửi nằm trong file `alerts.json`. Có thể dán link "Chia sẻ" từ website vào, ví dụ
`{ "name": "Bộ lọc của tôi", "share": "https://...#s=..." }`.

## Lưu ý

- Giá: DNSE Lightspeed OpenAPI (chính thức, cần khoá); chưa có khoá thì dùng API biểu đồ công khai của DNSE. Chỉ số cơ bản (vốn hoá, P/E, EPS, cổ tức): VNDirect. Chỉ dùng cho mục đích cá nhân.
- GitHub tự tắt lịch chạy nếu repo không có cập nhật nào trong 60 ngày. Khi đó vào tab **Actions** bấm **Enable workflow**.
- Thông tin chỉ mang tính tham khảo, không phải khuyến nghị đầu tư.

## Chạy thử trên máy (dành cho lập trình viên)

```bash
python scripts/build_data.py --out web/public/data
cd web && npm install && npm run dev
```
