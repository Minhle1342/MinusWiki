# MinusWiki — Personal Knowledge Base Engine

MinusWiki là hệ thống quản lý tri thức cá nhân (PKB) thế hệ mới, thay vì lưu trữ tài liệu thô, hệ thống tự động **biên soạn (compile)** dữ liệu thành một Wiki Markdown có tính liên kết cao (Graph-based).

---

## 🚀 Tính năng cốt lõi
* **Compile Pipeline**: Chuyển đổi dữ liệu thô (PDF, DOCX, TXT) thành Wiki trang bằng LLM (Gemini/OpenAI).
* **Graph Inference**: Tự động tạo liên kết chéo dựa trên ngữ nghĩa của nội dung.
* **Semantic Graph**: Trực quan hóa tri thức với D3.js.
* **Contextual Q&A**: Chatbot hỏi đáp trên cơ sở tri thức đã biên soạn với dẫn nguồn chính xác.
* **Clipper Extension**: Lưu trữ nhanh từ web chỉ với một cú click.

## 🛠 Cấu trúc hệ thống (Technical Overview)
- `/extension`: Manifest V3 extension, giao tiếp trực tiếp qua REST API tới server.
- `/public`: SPA sử dụng PubSub event pattern, xử lý hiển thị D3.js và Markdown rendering.
- `/server.js`: **Core Engine**. Quản lý pipeline: `Ingest -> Extract -> Compile -> Link`.
- `/storage`: Database phẳng (.md files), cho phép backup/sync dễ dàng qua Git.

## ⚙️ Khởi chạy nhanh
1. `npm install`
2. Tạo `.env` (xem `.env.example`).
3. `npm start`
4. Truy cập `http://localhost:3000`

## 🛤 Roadmap
- [ ] **Vector Search Integration**: Thêm tìm kiếm semantic cho các tài liệu dài.
- [ ] **Local LLM Support**: Tích hợp Ollama để chạy offline hoàn toàn.
- [ ] **Graph Editing**: Thêm tính năng kéo-thả để chỉnh sửa liên kết trực tiếp trên đồ thị.
- [ ] **Multi-user Support**: Phân quyền dự án theo namespace.

## 💡 Phát triển (Dev Tips)
- **Cấu trúc lưu trữ**: Mỗi dự án nằm trong `storage/projects/<name>/`. Bạn có thể thoải mái copy folder này sang máy khác để backup tri thức.
- **Backend Debugging**: Mọi thao tác biên soạn (`Compile`) đều được ghi log vào console, giúp trace quá trình LLM tạo liên kết.
- **Đóng góp**: Sử dụng `standard` hoặc `prettier` để giữ code nhất quán.

---
*License: MIT | Built for personal intelligence.*
