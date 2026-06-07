# MinusWiki — Cơ sở tri thức cá nhân tự biên soạn bằng LLM

MinusWiki là một hệ thống quản lý và xây dựng cơ sở tri thức cá nhân (personal knowledge base) tự động. Khác với các hệ thống RAG (Retrieval-Augmented Generation) truyền thống luôn phải truy vấn trực tiếp trên tài liệu thô mỗi khi người dùng đặt câu hỏi, **MinusWiki** tự động biên soạn nội dung thô thành các trang tài liệu Markdown cấu trúc chặt chẽ, liên kết chéo với nhau, giúp người dùng dễ dàng duyệt cứu tri thức một cách trực quan thông qua đồ thị liên kết.

---

## 🚀 Các tính năng chính

1. **Quản lý dự án tri thức (Projects)**: Phân chia các cụm dữ liệu theo chủ đề (như Học máy, Y tế, Dự án cá nhân,...) một cách độc lập.
2. **Trích xuất tài liệu đa định dạng**: Hỗ trợ tải lên các tài liệu PDF, DOCX, XLSX, TXT, MD và tự động phân tích cú pháp để đưa vào hệ thống biên dịch.
3. **Biên soạn Wiki tự động (LLM-driven Wiki)**: Hệ thống sử dụng mô hình ngôn ngữ lớn (Gemini hoặc OpenAI) để phân tích nội dung nguồn mới tải lên, tự động cập nhật hoặc viết mới các trang tài liệu Markdown (`.md`), tự động liên kết chéo các trang bằng cú pháp Markdown chuẩn `[label](page.md)`.
4. **Đồ thị tri thức trực quan (Interactive Graph)**: Biểu diễn liên kết giữa các trang tài liệu dưới dạng đồ thị lực D3.js. Người dùng có thể nhấn để điều hướng nhanh, kéo thả các nút và phóng to/thu nhỏ.
5. **Hỏi đáp thông minh thông qua Chatbot**: Trả lời câu hỏi dựa trên các tài liệu đã được biên dịch trong hệ thống, kèm theo dẫn nguồn cụ thể (citations) trích xuất từ các trang Wiki tương ứng.
6. **Tiện ích Chrome Extension Clipper**: Cho phép bôi đen văn bản từ bất kỳ trang web nào và lưu nhanh trực tiếp vào dự án MinusWiki đang mở chỉ bằng một cú nhấp chuột hoặc thông qua Menu chuột phải.

---

## 📂 Cấu trúc thư mục dự án

```text
MinusWiki/
├── extension/             # Mã nguồn tiện ích mở rộng Chrome Clipper
│   ├── manifest.json      # Tệp cấu hình Manifest V3
│   ├── background.js      # Worker xử lý menu chuột phải & gửi dữ liệu
│   ├── popup.html         # Giao diện popup chọn dự án & điền thông tin
│   └── popup.js           # Logic kết nối API & lấy nội dung trang web
├── public/                # Giao diện Web SPA của MinusWiki
│   ├── index.html         # Layout 3 vùng responsive (Sidebar, View, Chat/Graph)
│   ├── style.css          # Giao diện tối hiện đại, hiệu ứng Glassmorphism
│   └── app.js             # Bộ điều khiển hướng sự kiện PubSub (D3.js, Markdown)
├── storage/               # Thư mục lưu trữ nội bộ
│   └── projects/          # Lưu trữ tài liệu nguồn và wiki từng dự án
├── server.js              # Express Backend xử lý API & Đường ống dẫn LLM (CoT)
├── .env                   # Khai báo khóa API & cấu hình cổng mạng
├── package.json           # Danh sách thư viện phụ thuộc
└── README.md              # Tệp tài liệu hướng dẫn (Tệp hiện tại)
```

---

## 🛠️ Hướng dẫn cài đặt và khởi chạy

### Bước 1: Tải mã nguồn và cài đặt thư viện phụ thuộc

Yêu cầu máy tính đã cài đặt **Node.js** (khuyến nghị phiên bản 18+).

Mở terminal tại thư mục dự án và chạy lệnh:
```bash
npm install
```

### Bước 2: Cấu hình môi trường

Tạo hoặc chỉnh sửa tệp `.env` tại thư mục gốc với các thông số sau:

```env
# Khai báo API Key của Gemini hoặc OpenAI để sử dụng tính năng LLM biên soạn tri thức
# Hệ thống sẽ ưu tiên sử dụng Gemini nếu phát hiện có API Key.
GEMINI_API_KEY=your_gemini_api_key_here
GEMINI_MODEL=gemini-1.5-flash

# Hoặc sử dụng OpenAI
OPENAI_API_KEY=your_openai_api_key_here
OPENAI_MODEL=gpt-4o-mini

# Cổng khởi chạy hệ thống (Mặc định 3000)
PORT=3000
```
> **Lưu ý**: Nếu bạn không cấu hình khóa API nào, MinusWiki sẽ tự động chạy ở **chế độ giả lập (Simulation Mode)** để bạn có thể trải nghiệm giao diện và các thao tác ghi nhận dữ liệu mà không tốn chi phí API.

### Bước 3: Khởi chạy máy chủ

Chạy lệnh dưới đây để bắt đầu khởi chạy máy chủ cục bộ:
```bash
npm start
```

Sau khi khởi chạy thành công, mở trình duyệt và truy cập: **`http://localhost:3000`**

---

## 💡 Hướng dẫn sử dụng chi tiết

### 1. Tạo và chọn dự án
* Tại thanh điều hướng góc trái, nhấp vào nút **Tạo dự án mới** (+).
* Nhập tên dự án (ví dụ: `Học máy 101`) rồi chọn dự án đó từ danh sách thả xuống.

### 2. Tải tài liệu nguồn lên
* Tại vùng quản lý tài liệu phía dưới thanh bên trái, nhấn vào vùng tải lên hoặc kéo thả tệp (`.pdf`, `.docx`, `.xlsx`, `.txt`) vào đây.
* Hệ thống sẽ tự động bắt đầu trích xuất và đưa văn bản vào hệ thống phân tích. Quá trình biên dịch tri thức và tạo trang sẽ mất một vài giây.

### 3. Đọc và chỉnh sửa các trang Wiki
* Sử dụng cây danh mục Wiki ở thanh bên trái để chọn trang bạn muốn đọc.
* Bạn có thể nhấn vào biểu tượng **Chỉnh sửa** (cây bút chì) ở góc trên khung hiển thị tài liệu để sửa đổi nội dung Markdown trực tiếp và lưu lại. Hệ thống sẽ tự động cập nhật lại đồ thị liên kết.

### 4. Khám phá đồ thị và trò chuyện hỗ trợ cứu cánh
* Nhấp vào tab **Đồ thị liên kết** ở góc phải để xem cấu trúc trực quan các chủ đề. Nhấp vào một quả bóng (nút trang) để tự động chuyển đến bài viết đó.
* Nhấp vào tab **Hỏi đáp tri thức** để nhập câu hỏi về các tài liệu đã tải lên. Robot sẽ trả lời kèm theo các trích dẫn màu xanh. Nhấp vào các trích dẫn này sẽ đưa bạn trực tiếp đến đoạn tư liệu gốc.

---

## 🔌 Hướng dẫn cài đặt Chrome Extension Clipper

Hệ thống đi kèm tiện ích mở rộng trình duyệt giúp lưu thông tin nhanh từ mọi trang web về MinusWiki.

1. Mở trình duyệt Google Chrome hoặc Microsoft Edge và truy cập trang quản lý tiện ích mở rộng: `chrome://extensions/`
2. Kích hoạt tính năng **Chế độ dành cho nhà phát triển (Developer mode)** ở góc trên bên phải.
3. Nhấp vào nút **Tải tiện ích đã giải nén (Load unpacked)** ở góc trên bên trái.
4. Chọn thư mục `extension` nằm bên trong thư mục dự án `MinusWiki`.
5. Đảm bảo rằng máy chủ Node.js của bạn đang chạy ở `http://localhost:3000`. 
6. Khi duyệt web, bạn có thể:
   * **Cách 1**: Bôi đen một đoạn văn bản trên trang, nhấp vào biểu tượng Tiện ích ở góc trình duyệt, chọn dự án MinusWiki của bạn và nhấn **Nạp tri thức**.
   * **Cách 2**: Bôi đen văn bản, click chuột phải và chọn **Lưu vùng chọn vào MinusWiki** để gửi nhanh cực kỳ tiện lợi.
