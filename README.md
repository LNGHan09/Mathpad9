# MathMate — Adaptive Math Lab

MathMate là bản mẫu full-stack cho đề tài nghiên cứu AI giáo dục: xây dựng hồ sơ năng lực Toán động từ lịch sử giải bài, nhận diện mẫu lỗi, dự đoán kỹ năng cần củng cố và cá nhân hóa quá trình luyện tập.


## 0. Chạy bằng một tệp HTML

Trong thư mục dự án có tệp `MathMate.html` (bản HTML một tệp, đã gộp CSS và JavaScript):

- **Dùng thử trực tiếp:** mở `MathMate.html` bằng Chrome/Edge. Đăng ký tài khoản và luyện đề; dữ liệu lưu trong localStorage của trình duyệt hiện tại. Bản này có trợ lý quy tắc offline, **không phải AI tạo sinh thật**. Dữ liệu không tự đồng bộ qua máy khác.
- **Bật AI thật và tài khoản máy chủ:** làm theo mục cài đặt bên dưới, rồi mở `http://localhost:3000`. Đây là giao diện full-stack kết nối trực tiếp với API, cơ sở dữ liệu, tài khoản thật và các endpoint AI. Không đưa API key vào HTML.

Bản HTML độc lập phù hợp trình diễn/prototype, không nên dùng để lưu dữ liệu nhạy cảm hoặc triển khai công khai như hệ thống tài khoản thực.

## Các tính năng đã có

- **Tài khoản riêng:** đăng ký, đăng nhập, đăng xuất, xóa tài khoản; mật khẩu được băm bằng bcrypt; phiên đăng nhập nằm trong cookie `HttpOnly`.
- **Dữ liệu tách biệt theo người dùng:** điểm số, lượt làm bài, kỹ năng, lộ trình và lịch sử hội thoại đều gắn với `user_id`. Gia sư AI chỉ lấy hồ sơ và hội thoại của tài khoản đang đăng nhập.
- **Đề thích ứng:** đề 10 câu gồm ba phần Nền tảng, Vận dụng và Thử thách; bộ câu hỏi mẫu có 48 câu; hệ thống ưu tiên kỹ năng có độ chính xác thấp, tránh lặp lại quá nhiều câu gần đây và vẫn giữ độ phủ kiến thức.
- **Nhiều dạng trả lời:** trắc nghiệm, câu trả lời ngắn, ghép cặp công thức và đặt điểm trên hệ trục tọa độ.
- **Hồ sơ năng lực động:** theo dõi độ chính xác, số lần làm, thời gian trung bình và mẫu lỗi theo kỹ năng.
- **Gia sư AI theo tài khoản:** hội thoại có lịch sử riêng, chẩn đoán dựa trên dữ liệu, sinh lộ trình, tạo bài “săn lỗi sai”, phân tích ảnh bài giải viết tay.
- **Lịch sử và bảng thi đua tự nguyện:** bảng thi đua chỉ hiển thị người đã bật chia sẻ; không hiển thị email.
- **Bản mẫu vẫn luyện đề được khi chưa có API key:** các chức năng gọi AI sẽ báo chưa cấu hình; không giả vờ rằng câu trả lời mẫu là AI thật.
- **Bảo vệ cơ bản:** giới hạn tần suất, kiểm tra nguồn yêu cầu, CSP/Helmet, xác thực phiên ở máy chủ, giới hạn dung lượng ảnh và phản hồi lỗi không tiết lộ stack trace.

> **Lưu ý về “AI riêng”:** mỗi tài khoản có một hồ sơ, lịch sử trò chuyện và ngữ cảnh cá nhân riêng. Các tài khoản gọi chung mô hình AI ở máy chủ; đây không phải là một mô hình được huấn luyện riêng cho từng học sinh. Cách làm này khả thi hơn về chi phí và vẫn giúp cá nhân hóa mà không trộn lịch sử của người dùng.

## 1. Cài đặt trên Windows

Cài Node.js 20 trở lên từ trang chính thức của Node.js, sau đó mở PowerShell hoặc Terminal tại thư mục `math-adaptive-ai`.

```powershell
npm install
Copy-Item .env.example .env
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

Mở file `.env`, dán chuỗi vừa tạo vào `JWT_SECRET`. Ví dụ:

```dotenv
JWT_SECRET=chuoi_ngau_nhien_vua_tao
OPENAI_API_KEY=
OPENAI_MODEL=gpt-5.5
```

Để chạy bài luyện và tài khoản, không nhất thiết phải có API key. Để bật gia sư AI, dán API key của bạn vào `OPENAI_API_KEY` trong `.env`, lưu tệp và khởi động lại máy chủ. Từ thư mục dự án chạy:

```powershell
npm run check
npm start
```

Mở `http://localhost:3000` trong trình duyệt. Dữ liệu tài khoản và tiến độ được lưu trong `mathai.sqlite` ngay trong thư mục dự án (hoặc tại đường dẫn `DATABASE_PATH` nếu bạn cấu hình riêng).

### Cách bật AI an toàn

- API key chỉ được đọc ở **máy chủ** từ `.env`; không đưa key vào `public/app.js`, HTML hoặc ảnh chụp màn hình.
- API có thể tính phí theo mức sử dụng và mô hình. Đặt giới hạn chi tiêu trong bảng điều khiển nhà cung cấp, và chỉ chia sẻ bản demo với người được phép.
- Nếu model mặc định không được cấp quyền cho tài khoản API, hãy đổi `OPENAI_MODEL` sang model mà tài khoản của bạn có quyền sử dụng.
- Ảnh lời giải tải lên sẽ được gửi tới nhà cung cấp AI để phân tích khi tính năng này được bật. Không tải ảnh có thông tin cá nhân không cần thiết.

## 2. Cấu trúc dự án

```text
math-adaptive-ai/
├── MathMate.html      # Bản HTML một tệp chạy thử độc lập
├── server.js          # API, xác thực, cơ sở dữ liệu, logic thích ứng và kết nối AI
├── questions.js       # Ngân hàng câu hỏi; đáp án chỉ ở máy chủ
├── package.json
├── .env.example
├── start-windows.bat
└── public/
    ├── index.html     # Giao diện ứng dụng
    ├── styles.css     # Giao diện responsive
    └── app.js         # Đăng nhập, luyện đề, dashboard và các tính năng trình duyệt
```

## 3. Luồng nghiên cứu được mã hóa trong sản phẩm

1. **Diagnosis:** thống kê theo kỹ năng từ câu trả lời, độ chính xác, thời gian và loại lỗi.
2. **Prediction (bản đầu):** ưu tiên các kỹ năng có độ chính xác thấp và lỗi gần đây; đây là heuristic thích ứng, chưa phải mô hình dự đoán đã được kiểm chứng khoa học.
3. **Intervention:** chọn cấu trúc đề theo mục tiêu điểm; sinh bài săn lỗi sai và lộ trình từ AI dựa trên hồ sơ từng tài khoản.
4. **Learning gain:** lưu lịch sử điểm để nghiên cứu trước/sau. Muốn tuyên bố hiệu quả cần thiết kế thí nghiệm có nhóm so sánh, tiêu chí đánh giá định trước và đủ mẫu học sinh.

## 4. Mở rộng trước khi dùng thật trong trường học

Đây là **bản mẫu nghiên cứu có thể chạy được**, chưa phải một dịch vụ thương mại đã được kiểm định an ninh. Trước khi công khai rộng rãi cần triển khai HTTPS, dùng cơ sở dữ liệu có quản lý khi vận hành nhiều máy chủ, sao lưu và khôi phục, quy trình quên mật khẩu, xác minh email, chính sách quyền riêng tư, quy trình đồng thuận phù hợp với học sinh, giám sát chi phí AI và kiểm thử bảo mật độc lập. SQLite phù hợp cho bản demo trên một máy; không nên đặt cơ sở dữ liệu này trên hệ thống triển khai có ổ đĩa tạm thời.

## 5. Tùy chỉnh ngân hàng đề

Mở `questions.js` và thêm câu hỏi vào mảng `questions`. Mỗi câu cần có `id` duy nhất, `section` (`foundation`, `application`, `challenge`), `difficulty`, `points`, `topic`, `skill`, `type`, `prompt`, `answer`, `explanation`, `errorType`. Với `mcq`, thêm `choices`; với `short`, thêm `accepted`; với `match`, định nghĩa `pairs` và `answer`; với `graph`, định nghĩa `graphBounds` và `graphFunction`. Đáp án chuẩn không được gửi ra trình duyệt — hàm `publicQuestion()` hiện chủ động loại đáp án khỏi API đề thi.
