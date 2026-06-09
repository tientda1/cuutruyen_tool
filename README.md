# 🌸 CuuTruyen Tool — Hướng Dẫn Sử Dụng 🌸

CLI tool sử dụng thư viện **Playwright** để tự động mở trình duyệt (Cốc Cốc, Chrome hoặc Edge), cuộn trang và tải các chương truyện từ `cuutruyen.net` về máy tính của bạn dưới dạng thư mục ảnh hoặc file nén `.zip`.

> **Lưu ý quan trọng**: Chỉ sử dụng công cụ này cho các nội dung truyện mà bạn có quyền truy cập hợp pháp.

---

## 🔰 Hướng Dẫn Cho Người Mới Bắt Đầu (Từng bước một)

Nếu bạn là người mới sử dụng lần đầu và không rành về kỹ thuật, hãy làm theo các bước đơn giản dưới đây:

### Bước 1: Cài đặt phần mềm nền tảng
Để chạy được tool, máy tính của bạn cần cài đặt **Node.js** (một nền tảng giúp chạy mã Javascript ngoài trình duyệt):
1. Truy cập trang chủ [Node.js (https://nodejs.org/)](https://nodejs.org/).
2. Tải về phiên bản khuyến nghị **LTS** (thường là bản bên trái, khuyên dùng cho phần lớn người dùng).
3. Mở file vừa tải về và tiến hành cài đặt (chỉ cần nhấn *Next* liên tục đến khi hoàn tất).

### Bước 2: Mở thư mục Tool bằng PowerShell
1. Giải nén thư mục chứa tool này.
2. Mở thư mục chứa tool lên (nơi bạn nhìn thấy các file `cli.js`, `package.json`,...).
3. Click chuột vào **thanh địa chỉ** của File Explorer (thanh hiển thị đường dẫn thư mục ở phía trên cùng).
4. Gõ chữ `powershell` và nhấn **Enter**.
   > 💡 *Ngay lập tức, một cửa sổ lệnh màu xanh (Windows PowerShell) sẽ hiện ra và tự động trỏ sẵn đến thư mục của tool.*

### Bước 3: Cài đặt Tool (Chỉ cần làm 1 lần duy nhất)
Tại cửa sổ PowerShell vừa hiện ra, sao chép và chạy lần loạt 2 lệnh sau (dán lệnh vào PowerShell bằng cách click chuột phải rồi nhấn Enter):

1. Tải và cài đặt các thư viện cần thiết:
   ```powershell
   npm install
   ```
2. Cài đặt lõi trình duyệt Playwright (dùng để tự động cuộn trang và tải ảnh):
   ```powershell
   npx playwright install chromium
   ```

### Bước 4: Chạy Tool bằng Giao Diện Tương Tác
Để khởi động tool với giao diện menu trực quan dễ dùng nhất, hãy dán lệnh dưới đây vào PowerShell và nhấn Enter:

```powershell
# Thiết lập tối ưu cấu hình để tránh bị lỗi chặn mạng
$env:CUUTRUYEN_PROFILE="default"
$env:CUUTRUYEN_DISABLE_HOST_MAP="1"

# Khởi động tool
node cli.js
```

---

## 🎮 Cách Điều Khiển Menu Tương Tác

Khi tool đã khởi động thành công, bạn sẽ thấy menu lựa chọn xuất hiện trong PowerShell:

1. **Di chuyển**: Sử dụng các phím mũi tên **Lên (↑)** và **Xuống (↓)** trên bàn phím để di chuyển vệt sáng đến tính năng mong muốn.
2. **Chọn / Bỏ chọn (Nếu chọn nhiều)**: Nhấn phím **Space (Khoảng trắng)** để đánh dấu tích chọn.
3. **Xác nhận**: Nhấn phím **Enter** để thực hiện hành động.

### 📚 Cách tải truyện qua Menu:
* Chọn **`📚 Duyệt danh sách truyện`** hoặc **`🔍 Tìm kiếm truyện`** (nhập tên truyện bạn muốn tìm).
* Chọn truyện từ danh sách kết quả.
* Chọn phương thức tải:
  * `Tải tất cả chapter`
  * `Chọn khoảng chapter` (Ví dụ: Từ chap 1 đến chap 10)
  * `Chọn từng chapter` (Nhập số chương cụ thể, ví dụ: `1,5,10-12`).
* **Lưu ý quan trọng khi tải**: 
  * Khi quá trình tải bắt đầu, tool sẽ tự động mở một cửa sổ trình duyệt Cốc Cốc/Chrome thật lên.
  * **Bạn cần giữ nguyên cửa sổ trình duyệt này mở trong suốt quá trình tải**, không được tắt đi. Tool sẽ tự cuộn trang và chụp lại ảnh render sắc nét nhất.
  * Nếu tool hiển thị thông báo yêu cầu click chương truyện thủ công, hãy chuyển sang cửa sổ trình duyệt và click vào chương tương ứng, tool sẽ tự động nhận diện và tiếp tục làm việc.

---

## 🍪 Cách Giải Quyết Khi Bị Lỗi Cloudflare / Chặn Truy cập

Nếu bạn gặp thông báo lỗi Cloudflare (yêu cầu xác minh con người) hoặc không tải được ảnh do trang yêu cầu đăng nhập:

1. Trong menu tương tác của tool, di chuyển và chọn **`🍪 Lấy cookies phiên đăng nhập từ browser`** (hoặc chạy trực tiếp lệnh `node cli.js cookies`).
2. Cửa sổ trình duyệt thật sẽ được tool mở ra.
3. Tại đây, hãy truy cập `cuutruyen.net`, thực hiện **đăng nhập** tài khoản của bạn và **hoàn tất xác minh con người / Cloudflare** nếu có.
4. Khi trình duyệt đã truy cập bình thường và tải xong trang truyện, bạn hãy quay lại cửa sổ lệnh PowerShell và nhấn **Enter**.
5. Tool sẽ tự động trích xuất cookie phiên đăng nhập đó lưu lại vào file `cuutruyen-cookies.json` để sử dụng cho các lần tải sau mà không lo bị chặn nữa.

---

## 📁 Thư Mục Lưu Trữ Ảnh Tải Về

Mặc định, toàn bộ truyện tải về sẽ nằm trong thư mục:
```text
downloads/
```
* **Định dạng mặc định (Thư mục ảnh)**: Mỗi chương truyện sẽ là một thư mục chứa các ảnh trang truyện đã được đánh số thứ tự từ đầu đến cuối:
  ```text
  downloads/
    Ten_Truyen_chap0001/
      0001.png
      0002.png
      0003.png
  ```
* **Định dạng file nén (ZIP)**: Nếu bạn cấu hình định dạng đầu ra là `zip`, file tải về sẽ có dạng `Ten_Truyen_chap0001.zip`.

---

## 💻 Sử Dụng Các Lệnh CLI Nâng Cao

Nếu đã quen sử dụng cửa sổ lệnh, bạn có thể chạy trực tiếp các lệnh cụ thể mà không cần thông qua menu tương tác:

### 1. Xem danh sách truyện mới cập nhật
```powershell
node cli.js list
node cli.js list --page 2
```

### 2. Tìm kiếm truyện theo tên
```powershell
node cli.js list --search "Tên truyện cần tìm"
```

### 3. Xem danh sách các chương của một bộ truyện
```powershell
node cli.js chapters https://cuutruyen.net/mangas/ID_TRUYEN
```

### 4. Tải một chương truyện cụ thể
```powershell
# Tải và lưu dưới dạng thư mục ảnh (Mặc định)
node cli.js download https://cuutruyen.net/chapters/ID_CHAPTER --manga https://cuutruyen.net/mangas/ID_TRUYEN

# Tải và đóng gói thành file ZIP
node cli.js --format zip download https://cuutruyen.net/chapters/ID_CHAPTER --manga https://cuutruyen.net/mangas/ID_TRUYEN
```

### 5. Tải nhiều chương truyện cùng lúc
```powershell
node cli.js download-all https://cuutruyen.net/mangas/ID_TRUYEN --from 1 --to 5
```

---

## ⚙️ Các Tùy Chọn Cấu Hình Chung

Bạn có thể thêm các tùy chọn này vào sau lệnh chạy để điều chỉnh hoạt động của tool:
* `--output <đường_dẫn>`: Thay đổi thư mục lưu truyện tải về (Mặc định là `./downloads`).
  * *Ví dụ: `node cli.js --output D:\TruyenTranh interactive`*
* `--format <folder|zip>`: Chọn lưu dưới dạng thư mục ảnh hoặc đóng gói nén ZIP (Mặc định là `folder`).
* `--concurrency <số_lượng>`: Số lượng ảnh tải song song cùng lúc (Mặc định là `10`).
* `--no-cache`: Bỏ qua dữ liệu cache cũ và tải lại danh sách truyện mới nhất.

---

## ❓ Các Lỗi Thường Gặp & Cách Khắc Phục

#### 1. Trình duyệt mở ra trang trắng (`about:blank`) và dừng lại
* **Khắc phục**: Dừng hẳn tool bằng cách nhấn tổ hợp phím `Ctrl + C` trên bàn phím. Đóng toàn bộ các cửa sổ trình duyệt do tool mở ra trước đó. Sau đó chạy lại tool bằng lệnh cấu hình tối ưu khuyến nghị ở **Bước 4**.

#### 2. Lỗi `Target page, context or browser has been closed`
* **Khắc phục**: Lỗi này xảy ra do bạn đã vô tình đóng cửa sổ trình duyệt Cốc Cốc/Chrome do tool tự mở lên trong quá trình tải truyện. Hãy chạy lại tool và giữ nguyên cửa sổ trình duyệt đó cho đến khi PowerShell thông báo hoàn thành tải.

#### 3. Báo lỗi `Không tìm thấy ảnh nào trong chapter này`
* **Khắc phục**: Thường do trang truyện chưa tải kịp ảnh trước khi chụp. Bạn hãy:
  - Đảm bảo giữ cửa sổ trình duyệt hiển thị rõ trên màn hình.
  - Chạy lại lệnh tải và thêm tùy chọn `--no-cache`.
  - Nếu cần, hãy bấm click chọn chương truyện trực tiếp trên cửa sổ trình duyệt để kích hoạt tải trang.
