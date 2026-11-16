# CHANGELOG — AlkCloud

> Ghi lại các thay đổi **có ảnh hưởng tới hành vi hoặc vận hành**.
> Mỗi mục có mã commit để tra ngược. Bằng chứng chi tiết: lịch sử commit + test tự động.

---

## [Unreleased] — 15/11/2026 — Đường dẫn rút gọn + bộ chọn thư mục kiểu Windows

> Trạng thái: **ĐÃ DEPLOY PRODUCTION** — Worker `alkcloud-api` version `4384bb69-c177-4587-95cb-789c5550f05c`
> · Worker `alkcloud-web` version `1ad9528a-7dc7-4bcc-9472-17c072f2af10` (entry `/app/B3oUr1AH/`).
> Kiểm thử: `typecheck` PASS · `npm test` **PASS=426 · FAIL=0** · `build` PASS · E2E production **PASS=22 · FAIL=0**.

### Added

| Hạng mục | Nội dung |
| :--- | :--- |
| **`GET /folders/tree`** | Cây thư mục phẳng (id, name, parentId, depth) — 1 request thay vì gọi lặp từng cấp; giới hạn 1000 node |
| **`apps/web/src/lib/path.ts`** | `buildPath()` · `shortenPath()` (rút gọn kiểu Explorer: giữ phần cuối, tiền tố `…/`; tên quá dài thì cắt giữa) · `pathOfNode()` |
| **Hộp thoại "Di chuyển"** | Chuyển từ `<select>` optgroup sang **cây thư mục kiểu Windows**: thụt lề theo cấp, chevron thu gọn/mở rộng, click để chọn — **không còn ô tickbox**; thanh trên hiển thị đường dẫn đích đã rút gọn (tooltip hiện đường dẫn đầy đủ) |

### Changed

| Hạng mục | Nội dung |
| :--- | :--- |
| **An toàn khi di chuyển** | Tự động loại trừ thư mục đang di chuyển **và toàn bộ nhánh con cháu** khỏi cây chọn đích ⇒ không tạo vòng lặp thư mục (trước: `<select>` chỉ có cha + con trực tiếp) |
| **Tải cây thư mục** | `FilesPage` nạp `/folders/tree` **lazy** — chỉ gọi khi mở hộp thoại "Di chuyển" |

### Test

- `apps/web/test/path.test.ts`: `buildPath` / `shortenPath` (rút gọn đầu, cắt giữa tên quá dài) / `pathOfNode`.
- `apps/api/test/product-journey.test.ts`: `GET /folders/tree` trả đủ node, `parentId` + `depth` đúng.

---

## [Unreleased] — 15/11/2026 — Xoá vĩnh viễn ⇒ tự thu hồi share

> Trạng thái: **ĐÃ DEPLOY PRODUCTION** — Worker `alkcloud-api` version `b4daf28d-ab80-4f09-8031-f7a30ce208d4`
> · Worker `alkcloud-web` version `0bfb352a-2057-48ba-a0bf-4c0352965833` (entry `/app/Bk2EweWQ/`).
> Kiểm thử: `typecheck` PASS · `npm test` **PASS=421 · FAIL=0** · `build` PASS · E2E production **PASS=22 · FAIL=0**.

### Changed

| Hạng mục | Nội dung |
| :--- | :--- |
| **`DELETE /files/:id/purge`** | Không còn chặn `409` vì "còn share đang hoạt động" — **tự thu hồi mọi share** của file rồi mới purge. Link chia sẻ cũ chết ngay (share bị đánh dấu `revoked_at` + bị xoá theo cascade khi row file bị xoá) ⇒ không để lại link "sống" mở ra 404 |
| **Cron purge (retention 30 ngày)** | Trước: file có share hoạt động bị `continue` ⇒ **không bao giờ được dọn** (rò quota/object vĩnh viễn). Nay cron thu hồi share rồi purge file như bình thường |
| **Audit** | Mỗi share bị thu hồi ghi 1 sự kiện `share.revoke` (actor = owner hoặc `cron`, metadata `reason: file_purge` / `file_purge_retention`); sự kiện `file.purge` kèm `revokedShares` |
| **DB** | Thêm `revokeActiveSharesForFiles(fileIds, now)` (chia lô 100 id) và `listFileIdsInFolderSubtree(id)` |
| **Web** | Hộp thoại "Xoá vĩnh viễn?" nói rõ: *"Các link chia sẻ của tệp này cũng sẽ bị thu hồi"* |

### Test

- `apps/api/test/trash-purge-immediate.test.ts`: purge file có share ⇒ `200`, share `info`/`download` ⇒ `404`, có audit `share.revoke`.
- `apps/api/test/purge-lifecycle.test.ts`: cron thu hồi share rồi xoá object + row (thay cho case "file có share thì không được purge").

---

## [Unreleased] — 15/11/2026 — Kiến trúc file: KHÔNG stream byte qua Worker + index đọc D1

> Trạng thái: **ĐÃ DEPLOY PRODUCTION** — Worker `alkcloud-api` version `934bd864-9e51-48e8-b6b3-1c381fc35d98`
> · Worker `alkcloud-web` version `8cdbc8a1-9e4a-4476-aa0b-49d2ab98ff2b` · web entry `/app/CVbB1pS3/`.
> Migration D1 **0007_read_indexes** đã áp dụng remote (backup trước deploy:
> `backups/alkcloud-d1-20261115T162427.sql`, 1.23 MB).
> Kiểm thử: `typecheck` PASS · `npm test` **PASS=420 · FAIL=0** · `build` PASS ·
> `check:limits` PASS (gzip 178.84 KiB) · `check-production-health.sh` PASS ·
> E2E production **PASS=22 · FAIL=0 · SKIP=0 · BLOCKED=0** (gồm Range 206 + filename UTF-8
> trên object B2 thật).

### Changed — file không đi qua Worker free plan

| Hạng mục | Nội dung |
| :--- | :--- |
| **Upload (single + multipart)** | Browser PUT **thẳng** presigned URL của B2; multipart presign theo lô 20 part (`POST /uploads/:id/parts`). Worker chỉ tạo session, ký URL, ghi D1 — **không nhận byte file**, không tốn CPU/body-limit 100 MB |
| **Bỏ proxy upload** | Xoá route `POST/PUT /uploads/:id/content` và fallback proxy trong web client ⇒ không còn đường nào đẩy byte qua Worker. PUT lỗi ⇒ báo lỗi + abort session (không âm thầm chuyển qua Worker) |
| **Download (owner)** | `GET /files/:id/download` trả **302** tới presigned GET của B2 (TTL 5 phút) thay vì stream body. `FilesPage` luôn mở presigned URL từ `/files/:id/open` |
| **Download (public share)** | `GET /public/share/download` trả **302**; thêm `GET /public/share/download-url` trả JSON `{url,fileName,size}` để SharePage fetch **trực tiếp B2** (token share vẫn nằm trong header, không vào query string). Vẫn kiểm tra grant/mật khẩu, Range hợp lệ và maxDownloads trước khi ký URL |
| **Presign GET** | Hỗ trợ `response-content-type` + `response-content-disposition` (giữ đúng tên file gốc khi navigation tải từ B2) |
| **B2 CORS** | Xác minh live 15/11: preflight `PUT` (content-type) và `GET` cho origin `https://cloud.alk.xx.kg` đều 200; expose `ETag` (multipart complete cần). Không đổi cấu hình bucket |

### Added — D1 index cho đường đọc metadata (giảm row bị tính tiền)

Migration `apps/api/migrations/0007_read_indexes.sql` (single-owner nên **không có `user_id`**;
khoá cây là `folder_id`/`parent_id` — `path` không lưu chuỗi):

- `idx_files_active_folder_name(folder_id, name_lower, id) WHERE deleted_at IS NULL` — list file trong thư mục + keyset, không temp sort.
- `idx_folders_active_parent_name(parent_id, name_lower) WHERE deleted_at IS NULL` — list folder con.
- `idx_shares_file_created(file_id, created_at DESC)` — danh sách share của 1 file.
- `idx_upload_sessions_open_created(status, created_at)` — dọn session OPEN cũ.
- Test `packages/db/test/read-indexes.test.ts` chốt `EXPLAIN QUERY PLAN` dùng đúng index (không `SCAN files`).

### Ghi chú vận hành (Worker Free 100k request/ngày)

- Mỗi file upload = 1 create + 1 complete (+ 1 presign mỗi 20 part); mỗi lượt tải = 1 request ký URL. Byte đi trực tiếp B2 ⇒ **không** tiêu request/CPU của Worker.
- Thumbnail/preview hoặc sync nhiều file nhỏ sẽ làm tăng request nhanh (mỗi file vẫn cần metadata + ký URL) — nếu thêm thumbnail phải sinh ở client hoặc cache sẵn, **không** proxy qua Worker.

---

## [Unreleased] — 15/11/2026 — Thùng rác: xoá vĩnh viễn NGAY (file + folder)

> Trạng thái: **ĐÃ DEPLOY PRODUCTION** — Worker `alkcloud-api` version `acce3937-190d-404a-9bbb-c55eccf0d8ad`
> (15/11 UTC) · Worker `alkcloud-web` version `32588f05-9fd9-4f90-838a-cc1530fef235` ·
> web entry `/app/DxeqQapH/` (bundle `index-DxeqQapH.js`).
> **Không có migration** (chỉ logic route + client). Kiểm thử: `typecheck` PASS · `npm test`
> **PASS=421 · FAIL=0** (122 suites) · `build` PASS · `check:limits` PASS ·
> `check-production-health.sh` PASS · E2E production **PASS=22 · FAIL=0 · SKIP=0 · BLOCKED=0**.

### Changed

- **`DELETE /files/:id/purge`**: owner được xoá vĩnh viễn **ngay**, không còn bị `409` vì
  `purge_after` chưa tới hạn 30 ngày. `purge_after` chỉ còn là mốc để cron tự dọn file bị bỏ quên
  ⇒ thao tác có chủ đích không phải chờ.
- **`DELETE /folders/:id/purge`** (mới): xoá vĩnh viễn **cả cây thư mục** đang ở trong thùng rác.
  Từ chối `409` nếu còn file trong cây con (phải purge hết file trước) để tránh xoá mồ côi.
  Audit action mới `folder.purge` (severity `data_change`).
- **Web**: nút "Xoá vĩnh viễn" luôn hiện với file trong thùng rác (trước chỉ hiện khi quá hạn 30 ngày);
  hàng thư mục trong thùng rác có thêm nút "Xoá vĩnh viễn" (icon + tooltip), hộp thoại xác nhận dùng
  chung `PurgeConfirmDialog`; thông báo lỗi khi thư mục còn file hiển thị đúng số file.
- **Verify**: thêm `apps/api/test/trash-purge-immediate.test.ts` (purge file ngay + purge folder
  chặn-khi-còn-file/rồi-thành-công); `product-journey` bước 12 chuyển sang purge ngay + purge folder;
  E2E production đổi bước "purge trước hạn 409" thành "purge ngay 200 → 404" và thêm "purge folder rỗng".

---

## [Unreleased] — 15/11/2026 — Grid view: bỏ hẳn tickbox trên card

- **View thẻ (grid) không còn tickbox nào** trên card — trả lại diện tích và tránh cảm giác "checkbox trôi" như các cloud drive khác.
- Chọn vẫn đầy đủ: **bấm card** (desktop) để chọn, **nhấn giữ ~450 ms** (touch, có rung nhẹ) để bật chế độ chọn, **bấm đúp** để mở file/thư mục. Card được chọn có viền + nền accent, thanh thao tác chọn (xoá/di chuyển/…) hiện phía trên.
- **View bảng (list) cũng bỏ cột tickbox** (và ô "Chọn tất cả" ở header): chọn bằng **bấm dòng**, bấm đúp để mở, chạm tên để mở trên touch; thay bằng nút chữ **"Chọn tất cả" / "Bỏ chọn tất cả"** trên toolbar (cùng nhóm với nút đổi kiểu hiển thị).
- Đã bỏ luôn CSS overlay checkbox (`.file-card__check`), cột `.drive__check`/`.drive__th--check` và thuộc tính `data-selection` không còn dùng; lưới cột của bảng + bố cục mobile được thu lại tương ứng.
- Đã deploy web: version `902e4aab-382a-4cfd-9ee2-7355b27dab64`, entry `/app/CSLQY3na/`.
- Verify: `typecheck` + **420 test PASS** + `vite build` PASS + `check:limits` PASS.

---

## [Unreleased] — Phase 9 (15/11/2026) — KIỂM TOÁN CHỨC NĂNG + SỬA 9 LỖI (ĐÃ DEPLOY API + WEB)

> Trạng thái: **ĐÃ DEPLOY PRODUCTION** — Worker `alkcloud-api` version `df814f40-d4a1-48f5-a2fa-627f5793cba8`
> (15/11 15:14 UTC) · Worker `alkcloud-web` version `8e2819ad-1973-4937-82a9-f69528c6e0d5` (15/11 15:15 UTC) ·
> web entry `/app/DmS_gYlo/` (bundle `index-DmS_gYlo.js`).
> **Không có migration** trong lô này (chỉ logic route + client) ⇒ không cần migrate D1.
> Backup D1 production trước deploy: `backups/alkcloud-d1-20261115T151328.sql` (1.18 MB).
> Kiểm thử trước deploy: `typecheck` PASS · `npm test` **PASS=419 · FAIL=0** (121 suites) · `build` PASS ·
> `check:limits` PASS (gzip 179.07 KiB) · `check-deployment.sh` PASS · `audit:quota` **PASS=33 · WARN=0 · FAIL=0** ·
> `check-production-health.sh` PASS.
> Ma trận kiểm thử **HTTP thật** trên stack audit cô lập (API 8790 · s3rver 9010 · relay 9510 · D1 riêng):
> **26 test · 25 PASS · 1 BLOCKED · 0 FAIL**.
> E2E production sau deploy: **PASS=21 · FAIL=0 · SKIP=0 · BLOCKED=0**.
> Báo cáo: `docs/48-FUNCTIONAL-AUDIT-REPORT.md` · Ma trận: `docs/49-FUNCTIONAL-TEST-MATRIX.md` ·
> Sổ xác minh: `docs/54-VERIFICATION-LEDGER-PHASE9.md`.

### Fixed

| ID | Lỗi | Mức độ |
| :--- | :--- | :--- |
| BUG-35 | `GET /files` không phân trang (`cursor` bị bỏ qua, không có `nextCursor`) ⇒ file thứ 101 trở đi không bao giờ hiện | Cao |
| BUG-36 | `GET /files?trashed=true` lọc nhầm `folder_id IS NULL` ⇒ file nằm trong thư mục đã xoá không hiện trong thùng rác | Cao |
| BUG-37 | `POST /files/:id/move` không validate body ⇒ file **lặng lẽ** bị chuyển về thư mục gốc khi body thiếu/sai field | Cao |
| BUG-38 | `version` được schema khai báo nhưng route không kiểm tra ⇒ mất cập nhật âm thầm (hai tab cùng sửa 1 file) | Trung bình |
| BUG-39 | `GET /system/audit?limit=1.5` ⇒ HTTP **500** (`D1_ERROR: datatype mismatch`) thay vì 400 | Trung bình |
| BUG-40 | Multipart không kiểm tra tổng bytes thực tế ⇒ row D1 ghi `size` lệch với object (quota lệch, tải sai nội dung) | Cao |
| BUG-41 | Huỷ upload single-part để lại **object mồ côi** trong bucket (không còn row nào trỏ tới) | Trung bình |
| BUG-42 | Web: hộp thoại xác nhận xoá/purge **kẹt ở loading** sau lần dùng đầu (component không unmount ⇒ state `busy` sống sót) | Cao |
| BUG-43 | Web: danh sách file cắt cứng ở 100 mục (API trả 100, client không lấy tiếp) | Cao |

### Changed

| Hạng mục | Nội dung |
| :--- | :--- |
| **`GET /files`** | Trả thêm **`nextCursor`** (base64url mã hoá mốc `(name_lower, id)`) hoặc `null` khi hết danh sách. Phân trang theo **keyset** (không `offset`) ⇒ không trùng/không thiếu khi danh sách thay đổi giữa 2 lần gọi. `cursor` sai định dạng ⇒ `400` |
| **`GET /files` — phạm vi lọc** | `trashed=true` mà không có `parentId` ⇒ trả **mọi** file trong thùng rác (trước: chỉ file ở thư mục gốc) |
| **`POST /files/:id/move`** | Body phải có `folderId` (bắt buộc, `null` = về gốc) — schema mới `fileMoveSchema`; body rỗng/sai field ⇒ `400` (trước: `200` + chuyển về gốc) |
| **Optimistic concurrency** | `version` (tuỳ chọn) trong body rename/move/delete của **file** và **folder**: khớp ⇒ thực hiện, lệch ⇒ `409`. UPDATE có điều kiện `AND version = ?` ⇒ atomic. Client **không** gửi `version` ⇒ hành vi không đổi |
| **`DELETE /uploads/:id`** (single-part) | Xoá object đã PUT trong bucket khi huỷ session (trước: để lại object mồ côi) |
| **`GET /system/audit`** | `limit` phải là **số nguyên** trong `[1,500]`; sai ⇒ `400` |
| **Web client** | `listFiles()` nhận `cursor` + trả `nextCursor`; thêm `listFilesAll()` lần theo cursor (trần 50 trang = 5000 file); `FilesPage` dùng `listFilesAll()` |

### Added

| Hạng mục | Nội dung |
| :--- | :--- |
| Ma trận kiểm thử HTTP thật | `apps/api/test/integration/functional-audit.test.ts` — 26 test, không mock API, tự skip khi không có `ALKCLOUD_AUDIT_BASE` |
| Regression test | `apps/api/test/functional-audit-regression.test.ts` (14 test) · `apps/web/test/pagination.test.ts` (4 test) |
| Tài liệu | `docs/48` … `docs/54` (báo cáo audit, ma trận test, phân trang, concurrency, toàn vẹn upload, sửa web, sổ xác minh) |

### Not deployed / còn mở

| Hạng mục | Ghi chú |
| :--- | :--- |
| Multipart ở tầng HTTP | **BLOCKED**: storage local `s3rver` không implement `ListParts` (`405`) ⇒ đã có regression test tầng app (`MockObjectStorage`) và test HTTP được đánh dấu `skip` kèm lý do. Luồng multipart production đã được E2E chạy thật (PASS) |
| Turnstile | `TURNSTILE_SECRET_KEY` chưa được verify ở đâu; production **chưa bật** ⇒ P3, tách lô riêng |
| Web client gửi `version` | API đã hỗ trợ optimistic concurrency nhưng web client chưa gửi `version` ⇒ hành vi hiện tại không đổi (xem `docs/51` §5) |

---

## [Unreleased] — Phase 8.1 (15/11/2026) — SỬA LỖI DI CHUYỂN THƯ MỤC CÓ CON TRONG THÙNG RÁC (ĐÃ DEPLOY API)

> Trạng thái: **API ĐÃ DEPLOY PRODUCTION** — Worker `alkcloud-api` version `66f43ad2-ee82-4ffc-bd4c-96665e2b3913`
> (15/11 07:01 UTC). Health `https://api.alk.xx.kg/health` 200 · `https://api.alk.xx.kg/api/v1/health` 200 ·
> E2E production **PASS=21 · FAIL=0** · kiểm chứng lỗi trực tiếp trên production (cây 33 tầng + xoá mềm
> tầng sâu nhất ⇒ `move` trả **200** thay vì 400) · backup D1 production trước deploy:
> `backups/alkcloud-d1-20261115T070104.sql` (1.13 MB).
> Kiểm thử trước deploy: `typecheck` PASS · `401/401 test` PASS · `build` PASS · `check:limits` PASS (gzip 177.79 KiB) ·
> `check-deployment.sh` PASS · `audit:quota` PASS=33.
> Test hồi quy mới: `apps/api/test/api.test.ts` (cây 33 tầng, xoá mềm tầng sâu nhất) + `packages/db/test/repositories.test.ts`.
>
> Ghi chú vận hành (15/11): production đã dọn 33 thư mục rác nằm trong trash (sinh ra khi import cây thư mục
> Google Drive với path sai) bằng `DELETE` trực tiếp trên D1 — trước khi vá, cây trash đó làm chặn
> `move` của thư mục cha (`400 "Độ sâu thư mục vượt giới hạn"`). Nhánh thử nghiệm verify fix (34 node)
> cũng đã được dọn khỏi D1 sau khi kiểm chứng.

### Fixed

| ID | Lỗi | Mức độ |
| :--- | :--- | :--- |
| BUG-33 | `POST /folders/:id/move` trả `400 "Độ sâu thư mục vượt giới hạn"` cho thư mục có con đã xoá (trash) — `listFolderSubtree` tính cả cây trash vào độ sâu | Cao |

### Changed

| Hạng mục | Nội dung |
| :--- | :--- |
| **`listFolderSubtree`** | Thêm tuỳ chọn `includeDeleted` (mặc định `true` — giữ nguyên hành vi cũ). Route `move` dùng `includeDeleted: false` ⇒ chỉ cây active tính vào độ sâu; route `delete`/`restore` giữ mặc định vì cần nhìn thấy cây trash (gom batch xoá / khôi phục file theo batch) |

---

## [Unreleased] — Phase 8 (15/11/2026) — HOÀN THIỆN TRẢI NGHIỆM NGƯỜI DÙNG (ĐÃ DEPLOY WEB)

> Trạng thái: **WEB ĐÃ DEPLOY PRODUCTION** — Worker `alkcloud-web` (15/11 08:13 UTC) · `/` → 307 → `/app/CIuMbj7e/` ·
> bundle `index-CIuMbj7e.js` 366.48 kB (gzip **112.07 kB**) · `index-Cg-zTtgA.css` 56.55 kB.
> Đã kiểm thử thật trên stack local (Vite HTTPS + `wrangler dev` + s3rver + relay) **trước khi deploy**,
> không ghi dữ liệu test lên production.
> Regression (sau BUG-34): `typecheck` PASS · `401/401 test` PASS · `build` PASS · `check:web` PASS ·
> browser test 7 viewport: **0 issue · 0 console error** · test luồng "di chuyển lên thư mục cha" PASS.
> Bằng chứng: `docs/45-USER-EXPERIENCE-AUDIT.md` · `docs/46-UX-FIXES-AND-IMPROVEMENTS.md` · `docs/47-BROWSER-TEST-REPORT.md`.

### Added

| Hạng mục | Nội dung | Tài liệu |
| :--- | :--- | :--- |
| **Skip-link** | `<a class="skip-link" href="#main-content">` + `<main id="main-content" tabIndex={-1}>` — bàn phím bỏ qua menu | `docs/46` §4.4 |
| **ARIA bảng đầy đủ** | `.drive` → `role=table` + `aria-label`; `columnheader` + `aria-sort`; `role=cell` cho từng ô (18 hàng / 85 ô) | `docs/46` §3.4 |
| **Điều hướng menu bằng bàn phím** | `Menu` + `ContextMenu`: focus mục đầu khi mở, `↑ ↓ Home End`, `Esc` trả focus về trigger, `aria-haspopup/expanded/controls` | `docs/46` §4.1 |
| **Audit tự động 12 nhóm** | Harness Playwright (ngoài repo): tràn ngang, vùng bấm ≥24px, tương phản WCAG, `h1`, id trùng, nhãn form, ARIA parent, tab-stop ẩn | `docs/45` §1.2 |

### Fixed

| ID | Lỗi | Mức độ |
| :--- | :--- | :--- |
| BUG-25 | Drawer mobile khi đóng vẫn nằm trong tab order (focus rơi vào menu ở `x = −252`) | Cao |
| BUG-26 | Thiếu `<h1>` ở 3 view (Tệp / Thùng rác / Cài đặt) | Trung bình |
| BUG-27 | Vùng bấm checkbox 32×16 (< 24px theo WCAG 2.5.8) | Trung bình |
| BUG-28 | Tương phản `--text-muted` 4.45:1 trên dòng đã chọn (< 4.5:1) | Trung bình |
| BUG-29 | `role="row"` không có parent `role="table"` ⇒ ARIA không hợp lệ | Trung bình |
| BUG-30 | Nút **⋮** không hiện ở tablet 768px / thiết bị touch (chỉ mở khi hover) | Trung bình |
| BUG-31 | Checkbox trong card lưới `opacity: 0` trên touch ⇒ không chọn được trên điện thoại | Trung bình |
| BUG-32 | Nút "Tải lại" rơi xuống dòng riêng ở 768px (nằm ngoài nhóm công cụ) | Thấp |
| BUG-34 | Hộp thoại **Di chuyển** không có lựa chọn **thư mục cha** ⇒ không đưa được mục lên 1 cấp (chỉ chọn được "Thư viện (gốc)" hoặc thư mục con) | Cao |

### Changed

| Hạng mục | Nội dung | Tài liệu |
| :--- | :--- | :--- |
| **Token `--text-muted`** | Light theme `#667085` → `#616b80` (≥4.79:1 trên mọi nền); dark theme không đổi | `docs/46` §3.3 |
| **Token bấm trên touch** | Chạm 1 lần vào tên (bảng) / thân card (lưới) để mở, như Google Drive mobile; bấm đúp bị chặn trên touch | `docs/46` §4.5 |
| **Bundle web** | P8 (đã deploy): `index-CIuMbj7e.js` 366.48 kB (gzip **112.07 kB**), `index-Cg-zTtgA.css` 56.55 kB (gzip 10.39 kB) | `docs/14` §1 |

---

## [Unreleased] — Phase 7 (14/11/2026) — DEPLOY WEB (REDESIGN UI/UX)

> Trạng thái: **WEB ĐÃ DEPLOY PRODUCTION**. Worker `alkcloud-web` version `00f603d9-c28c-4ab9-8543-6bbd2f1a69c9` (14/11 16:48 UTC — Phase 7.3);
> `/` → 307 → `/app/BxvwFSFY/`; E2E production `PASS=21 · FAIL=0`; `check-production-health` PASS.
> Bằng chứng: `docs/34-PRODUCTION-DEPLOYMENT-REPORT.md` §14–§17 · `docs/42-UI-UX-REDESIGN.md` · `docs/44-VISUAL-QA-REPORT.md`.

### Added

| Hạng mục | Nội dung | Tài liệu |
| :--- | :--- | :--- |
| **Redesign UI/UX toàn diện** | Design system (token light/dark, typography, component, breakpoint), file manager mới (grid/list, multi-select + bulk bar, sort, breadcrumb, drag&drop, upload queue tuần tự), trang Thùng rác, trang Cài đặt 4 mục, login 3 chế độ + recovery codes | `docs/42`, `docs/43` |
| **Danh sách kiểu Google Drive / Nextcloud (P7.2)** | Bảng cột Tên / Sửa đổi / Kích thước (mặc định list), sort bằng click tiêu đề cột + đảo chiều, menu chuột phải (`ContextMenu.tsx`), click = chọn / bấm đúp = mở / Enter = mở, bộ đếm "N thư mục · M tệp", meta gộp cho mobile | `docs/42` §7, `docs/34` §16c |
| **Font tự host** | Inter (SIL OFL 1.1) — 3 file `woff2` + `OFL.txt`; không gọi font bên thứ ba | `docs/43` |
| **Helper KDF cho script Node** | `scripts/lib/auth-key.ts` — PBKDF2 theo `params` server trả (fallback Argon2id cho tài khoản cũ) | `docs/34` §16 |

### Fixed

| ID | Lỗi | Mức độ |
| :--- | :--- | :--- |
| BUG-15 | `infra/check-production-health.sh` fail vì kỳ vọng `/` trả 200 trong khi entry point có version trả 307 | Trung bình |
| BUG-16 | Script E2E/verify-auth/verify-monitoring hard-code Argon2id ⇒ không chạy được sau khi server chuyển KDF sang PBKDF2 | Cao |
| BUG-17 | `scripts/bootstrap-owner.ts` tạo owner bằng Argon2id ⇒ tài khoản mới không đăng nhập được | Cao |
| BUG-18 | `__BUILD_ID__` bị tree-shake ⇒ mất cơ chế đối chiếu bundle theo runbook | Thấp |
| BUG-19 | `npm run bench` fail `POST /uploads → 429`: benchmark tạo 200 session upload rồi mới huỷ, vượt `MAX_OPEN_UPLOAD_SESSIONS = 50` (guard Phase 6) | Trung bình |
| BUG-20 | Upload chậm: dữ liệu đi qua 2 Worker hop (API → relay → B2) + 3 lượt gọi API tuần tự mỗi file | Trung bình |
| BUG-21 | Upload trùng tên báo "Thất bại" (409) dù file đã có trong thư mục; session `OPEN` bị rò quota | Cao |
| BUG-22 | Hàng đợi upload chạy tuần tự ⇒ nhiều file rất chậm | Thấp |
| BUG-23 | Menu nút **⋮** trong bảng Drive bị container `overflow: clip` cắt mất ⇒ menu hiện dở / "ẩn vào trong bảng" | Trung bình |
| BUG-24 | Dạng lưới ("dạng ô") hiển thị thô: ô preview cao 80px, icon nhỏ, nền màu lệch ⇒ giao diện xấu | Thấp |

### Changed

| Hạng mục | Nội dung | Tài liệu |
| :--- | :--- | :--- |
| **Bundle web** | P7.3: `index-BxvwFSFY.js` 362.82 kB (gzip **111.07 kB**), `index-DBfBSX2J.css` 55.63 kB (gzip 10.24 kB), `react-DbHEDQBy.js` 11.72 kB | `docs/14` §1 |

---

## [Unreleased] — Phase 5 (13/11/2026) — DEPLOY PRODUCTION

> Trạng thái: **PRODUCTION VERIFIED**. API + relay + Web + D1 + DNS + owner + cron + B2 đã chạy thật;
> E2E `PASS=21 · FAIL=0 · SKIP=0 · BLOCKED=0`, `verify-all` `PASS=24 · FAIL=0 · SKIP=0 · BLOCKED=0`.
> Bằng chứng: `docs/34-PRODUCTION-DEPLOYMENT-REPORT.md` · `docs/35-PRODUCTION-VERIFICATION.md`.

### Added

| Hạng mục | Nội dung | Tài liệu |
| :--- | :--- | :--- |
| **Production deploy** | Worker `alkcloud-api` (route `api.alk.xx.kg/api/v1/*`), Worker `alkcloud-web` (`cloud.alk.xx.kg`), D1 `alkcloud` (16 bảng, migration 0001…0005), CNAME `cloud` (proxied) | `docs/34` §2 |
| **Owner bootstrap CLI** | `scripts/bootstrap-owner.ts` — Argon2id, idempotent, lưu 10 recovery code mode 600 | `docs/35` §3 |
| **Xác minh production** | `scripts/verify-auth-production.ts` (13 kiểm tra), `scripts/verify-monitoring-production.ts`, `scripts/run-e2e-production.ts` (wrapper E2E, tự tính authKey) | `docs/35` |
| **Loader token theo nhãn** | `infra/lib/cf-token.sh` — nạp token Cloudflare theo label (`Edit Cloudflare Workers`, `AlkCloud-Baseline-ReadOnly`, …), truyền qua env (không argv) | `docs/34` §3 |
| **CSP cho static assets** | `apps/web/public/_headers` — Workers Static Assets phục vụ asset **không** gọi Worker ⇒ phải khai báo header qua file `_headers` | `docs/34` §4 |
| **B2 storage thật** | Bucket `alkcloud-storage` (private, SSE-B2 `AES256`, CORS origin `cloud.alk.xx.kg`, expose `ETag`); 5 secret `B2_*` set; integration test 2/2; E2E file đầy đủ | `docs/35` §3 |
| **Relay `alkcloud-b2relay`** | Worker workers.dev chỉ nhận request server-side đã ký; token bí mật + host allowlist; deploy + health/401 checks | `docs/34` §4, `apps/b2relay/` |
| **Proxy trong storage adapter** | `packages/storage/src/b2.ts` thêm `B2ProxyConfig`; `signedFetch` đi qua relay, presign vẫn trỏ thẳng B2 | `docs/34` §4 |
| **CORS bucket** | `PutBucketCors` (SigV4) — origin `https://cloud.alk.xx.kg`, methods GET/PUT/HEAD, expose `ETag`, max-age 3600; xác minh bằng preflight + PUT thật | `docs/35` §3.1 |

### Fixed

| ID | Lỗi | Mức độ |
| :--- | :--- | :--- |
| BUG-02 | `backup-d1.ts` bỏ qua `--remote` ⇒ file backup không phản ánh dữ liệu production | Cao |
| BUG-03 | `e2e-production.ts`: message `assert()` tiêu thụ body ⇒ “Body has already been read” | Trung bình |
| BUG-04 | Prefix test có `/` ⇒ API cấm ký tự phân tách trong tên ⇒ payload 400 (lỗi ở harness, API đúng) | Trung bình |
| BUG-08 | `restore-drill.ts` không nhận file backup có sẵn ⇒ chưa từng chứng minh restore từ backup production | Trung bình |
| BUG-09 | `release-manifest.ts` mất danh sách secret khi tên secret kèm chú thích trạng thái | Cao |
| BUG-10 | Test chaos `T5` phụ thuộc `wrangler.toml` thật ⇒ không kiểm chứng được guard placeholder | Trung bình |
| BUG-12 | `alkApiCallsUsed` **luôn = 0** (Cloudflare gom request Worker-route vào `__unknown__`) ⇒ cảnh báo ngân sách riêng không bao giờ kích hoạt | Cao |
| BUG-13 | Chẩn đoán B2 sai: probe thiếu `/b2api/v2/` + B2 bỏ field JSON trong `AuthorizeAccountRequest` (phải dùng HTTP Basic) ⇒ kết luận nhầm “key không tồn tại” | Cao |
| BUG-14 | E2E gửi `passwordParams: 'sha256'` (6 ký tự) vi phạm `min(8)` ⇒ tạo share 400; web thật gửi `'sha256-v1'` | Trung bình |
| BUG-15 | E2E cleanup xoá object B2 khi metadata còn trong trash ⇒ `audit:storage` báo CRITICAL `missing_object` giả | Trung bình |
| BUG-16 | Worker zone-bound (`api.alk.xx.kg`) fetch B2 = **HTTP 525**, kể cả qua service binding; chỉ workers.dev công khai mới đi được | Cao |

### Changed

| Hạng mục | Nội dung |
| :--- | :--- |
| `infra/verify-all.sh` | restore drill chạy **từ file backup** (thay vì D1 local thường rỗng) · E2E dùng wrapper production · thêm bước kiểm tra gateway bằng HTTP |
| `infra/check-cloudflare-token.sh` | mỗi quyền dùng token riêng theo nhãn (analytics ≠ dns) ⇒ PASS=5/5 |
| `infra/check-dns.sh` | xác nhận gateway + route AlkCloud bằng **HTTP thật** thay vì SKIP |
| `scripts/lib/snapshot.ts` | `ALKCLOUD_WRANGLER_TOML` override ⇒ test guard dùng fixture, không phụ thuộc trạng thái production |
| `infra/check-b2.sh` | Maintenance key thành **OPTIONAL** (không còn `NOT_CONFIGURED`) · bổ sung kiểm tra region/endpoint |
| `infra/verify-all.sh` | Thêm check relay B2; thông điệp B2 không còn “blocked” |
| `infra/check-deployment.sh` | Kiểm tra `B2_RELAY_URL`, `workers_dev=true`, `B2_ALLOWED_HOST`, `B2_RELAY_TOKEN` trong secret bắt buộc |
| `scripts/e2e-production.ts` | `passwordParams: 'sha256-v1'`; cleanup giữ object B2 cho retention purge |

---

## [Unreleased] — Phase 4 (12/11/2026)

> Trạng thái: **chưa deploy**. Mọi thay đổi dưới đây đã qua test local (347 pass / 0 fail)
> và quality gate (`verify-all.sh`: PASS=16, FAIL=0), nhưng **chưa** được kiểm chứng
> trên production. Mức độ sẵn sàng: **READY FOR OWNER APPROVAL**.

### Added

| Hạng mục | Nội dung | Tài liệu |
| :--- | :--- | :--- |
| **WS-K — Observability** | Log có cấu trúc (JSON 1 dòng, redact trước khi log, catalog sự kiện cố định); heartbeat sức khoẻ trong D1 (`system_health`); `GET /system/diagnostics` (cron/degradation/storage/quota/analytics) | `docs/31` |
| **WS-L2 — Release engineering** | `npm run release:manifest` + `release:verify` — checksum từng artifact, thứ tự migration, secret checklist, kiểm tra bundle ≤ 3 MiB gzip, phát hiện artifact bị sửa | `docs/32` |
| **WS-L2/M13 — Owner onboarding CLI** | `npm run owner:onboarding` (checklist 1 lệnh + hành động kế tiếp) · `npm run owner:secrets` (sinh pepper + bootstrap token cục bộ, file mode 600) | `docs/33` |
| **WS-C — Storage integrity tooling** | `audit:storage` (quét 2 chiều DB↔B2), `reconcile:storage` (lệch), `verify:backup`, `restore:drill` (2 pha) | `docs/22`, `docs/24` |
| **WS-L — Chaos/failure harness** | 29 kịch bản hỏng (DB, B2, mạng, quota, concurrency) | `docs/24` |
| **WS-F — Product E2E** | Hành trình 14 bước + bất biến I1 (metadata⇄object), I2 (quota), I3 (audit); share không cần tài khoản; multipart > 100 MB | — |
| **WS-G — Performance benchmark** | `npm run bench` — 6 đường đo, 3 round lấy trung vị, budget nội bộ, `benchmarks/baseline.json` | `docs/27` |
| **WS-H — Cost model** | `npm run cost` — 4 kịch bản B2/Cloudflare/D1; phát hiện egress chi phối + rủi ro quota dùng chung account | `docs/28` |
| **WS-I — Frontend quality** | 31 test client (argon2 / API / upload) + static check AST W1–W7 tự suy ra 34 sink API | `docs/29` |
| **WS-J — CI** | `.github/workflows/ci.yml` — 3 job (quality 15 bước, security, build-artifacts), `permissions: contents: read`, **không deploy** | `docs/30` |
| **Migration `0004_perf_indexes.sql`** | Index `audit_chain.entry_hash` + `audit_logs.entry_hash` | `docs/27` |
| **Migration `0005_system_health.sql`** | Bảng heartbeat 1 dòng (UPSERT) | `docs/31` |

### Fixed

| Vấn đề | Mức | Mô tả | Tài liệu |
| :--- | :--- | :--- | :--- |
| **Rate limit không bao giờ chạy** | Cao | `createApp()` dựng lại mỗi request ⇒ limiter mất state. Sửa: cache app theo `env.DB` | `docs/25` §SEC-01 |
| **BUG-01 — share có mật khẩu luôn trả 400** | Trung bình | Web gửi `passwordParams: 'sha256'` (6 ký tự) < min 8. Sửa: `'sha256-v1'` | `docs/25` §BUG-01 |
| **Share bypass giới hạn tải** | Cao | Range 416 không trừ lượt tải. Sửa: `checkRange` + chỉ hoàn lượt khi lỗi server | `docs/25` §SEC-02 |
| **Hash mật khẩu share không salt/pepper** | Trung bình | Bổ sung `passwordSalt` + `passwordParams` vào hash | `docs/25` §SEC-03 |
| **Audit log không prune** | Trung bình | `pruneAuditLogs` (giữ 180 ngày, giữ `audit_chain`) | `docs/25` §SEC-04 |
| **Xoá folder vượt 50 subrequest** | Trung bình | 1 câu `WITH RECURSIVE` | `docs/25` §SEC-05 |
| **Login/recovery không giới hạn theo IP** | Trung bình | IP-only limiter + limiter theo email + `requireTrustedOrigin` | `docs/25` §SEC-06/07 |
| **`listAudit` O(n×m), không dùng index** | Trung bình | mean **5071 µs → 1047 µs** (4.8×), p95 **8443 µs → 1160 µs** | `docs/27` |
| **Lỗi B2 làm treo request** | Trung bình | `ResilientStorage`: retry có jitter + circuit breaker + `503 storage_unavailable` + `Retry-After` | `docs/26` |
| **Cron dùng thời gian thực cho dọn session** | Thấp | Dùng `scheduledTime` xuyên suốt (nhất quán, test được) | `docs/31` §3.3 |
| **Secret scanner bỏ sót file chưa track** | Trung bình | `git grep` → quét cây thư mục làm việc | `docs/31` §2 |
| **CI fail vĩnh viễn vì credential mẫu AWS** | Thấp | Test SigV4 dùng hằng thật ⇒ đổi sang hằng test | `docs/30` §3.1 |

### Security

| Hạng mục | Nội dung | Tài liệu |
| :--- | :--- | :--- |
| SEC-01…SEC-15 | 15 phát hiện audit độc lập Phase 4, **tất cả đã xử lý** | `docs/25`, `SECURITY_AUDIT.md` §1b |
| Usage counter gộp lô | `usage_daily.api_calls` ghi 1 lần / 20 request thay vì 1 lần/request | `docs/25` §SEC-13 |
| Rate limiter có giới hạn bucket | `maxBuckets` = 10 000 + `sweepAllLimiters()` trong cron | `docs/25` §SEC-15 |
| Log phải có cấu trúc + redact | `console.log` chỉ ở module observability; mọi dòng là JSON 1 dòng | `docs/31` §2 |
| Secret scan dùng chung local + CI | 5 check (mẫu secret, file nhạy cảm, cây thư mục, giá trị secret, `.env.example`) | `docs/30` |

### Changed

| Hạng mục | Nội dung |
| :--- | :--- |
| Chi phí ghi D1 | Audit ghi 2 dòng/sự kiện; `audit_chain` giữ vĩnh viễn (rủi ro R-24) |
| Chất lượng mã | Test từ 189 → **347**; typecheck 0 lỗi; `npm audit` 0 vulnerabilities |
| Bundle API | gzip 165.7 KiB → **178 840 B** (trần Workers Free 3 MiB) |

### Known limitations (cần owner biết)

| # | Hạng mục | Trạng thái |
| :--- | :--- | :--- |
| B3 | Bucket B2 + 2 app key chưa có | Chặn E2E/storage thật |
| B4 | Token Cloudflare thiếu `Account Analytics: Read` | Cron không tự degrade được |
| B5 | Chưa chọn kênh alert | Cảnh báo không tới ai |
| B6 | D1 production chưa tạo (`database_id` placeholder) | Chặn migration + E2E |
| B7 | DNS `cloud.alk.xx.kg` chưa có | Web chưa truy cập được |
| — | Rate limiter in-memory không chia sẻ giữa PoP | Lớp authoritative = Cloudflare Rate Limiting Rule |
| — | Share password dùng SHA-256 phía client | Cần **cả** D1 dump **và** pepper để tấn công offline |
| — | `usage_daily.api_calls` là số xấp xỉ | Số chưa flush bị mất khi Worker tắt đột ngột |

---

## [0.1.0] — Phase 3 (12/11/2026)

- 13 phát hiện audit độc lập đã sửa (rate limit, share grant/cookie/CSRF, restore safety).
- E2E harness production (tài nguyên thật, prefix riêng, cleanup, báo cáo JSON/MD).
- Operational readiness: health check, log safety redaction, incident checklist.
- `verify-all.sh` phân biệt PASS/FAIL/SKIP/BLOCKED (SKIP **không** tính là PASS).
- Owner setup tooling: `infra/check-{b2,cloudflare-token,d1,dns,owner-prerequisites}.sh`.
- 189 test / 0 fail. Mức độ sẵn sàng: **BLOCKED** — B3/B4/B6/B7.

## [0.0.1] — Phase 1–2

- Nền tảng: Worker API + SPA web + packages `core`/`db`/`storage`/`auth`.
- Argon2id client-side, `AUTH_PEPPER` server-side, recovery code 1 lần.
- B2 private bucket, presigned PUT, multipart > 100 MB, share có/không mật khẩu.
- Degradation 4 mode + hysteresis, trash 30 ngày + purge.
- Backup D1 2 pha, restore an toàn, storage audit 2 chiều.
