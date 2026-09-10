# Hararest

Hararest adalah aplikasi backend API untuk mengunduh media dari berbagai platform sosial media seperti YouTube, Instagram, Facebook, TikTok, Threads, dan Xiaohongshu. Proyek ini dibangun menggunakan Node.js (Express), TypeScript, serta memiliki fallback *scraper* menggunakan skrip Python.

## Persyaratan Sistem

Sebelum melakukan instalasi, pastikan sistem Anda telah terpasang perangkat lunak berikut:

- **Node.js 22.12+** (mengikuti kebutuhan Puppeteer yang terpasang)
- **npm** (biasanya sudah termasuk dengan instalasi Node.js)
- **Python** (versi 3.10+ untuk menjalankan skrip *scraper* fallback)
- **Google Chrome** atau **Chromium** (diperlukan untuk fitur Puppeteer)
- **yt-dlp** dan **FFmpeg** (unduhan dan konversi YouTube; yt-dlp juga digunakan sebagai fallback Facebook)
- **Tesseract OCR** dengan data bahasa `ind` dan `eng` (fitur OCR)

## Cara Instalasi (Pengembangan Lokal)

1. **Clone repositori ini:**
   ```bash
   git clone git@github.com:sanxlab/hararest.git
   cd hararest
   ```

2. **Instal dependensi Node.js:**
   ```bash
   npm ci
   ```

3. **Persiapkan dependensi Python:**
   Aplikasi membutuhkan library Python tertentu untuk fungsi *scraper* fallback (Instagram & Facebook). Anda disarankan untuk membuat *virtual environment*:
   ```bash
   python -m venv venv
   source venv/bin/activate  # Untuk Linux/macOS
   # atau venv\Scripts\activate untuk Windows

   pip install cloudscraper "yt-dlp[default]"
   ```

4. **Persiapkan berkas *environment*:**
   Salin berkas `.env.example` menjadi `.env`:
   ```bash
   cp .env.example .env
   ```
   Buka berkas `.env` dan sesuaikan nilai variabel di dalamnya, khususnya `PUPPETEER_EXECUTABLE_PATH` atau `CHROME_PATH` agar menunjuk ke *binary* browser di sistem Anda.

5. **Jalankan *server* pada mode *development*:**
   ```bash
   npm run dev
   ```
   *Server* akan otomatis ter-*restart* jika ada perubahan berkas sumber (berkat `ts-node-dev`).

## Menjalankan dengan Docker (Disarankan untuk Produksi)

Jika Anda ingin menjalankan aplikasi dengan menggunakan Docker tanpa harus mengonfigurasi dependensi secara manual:

1. Pastikan Anda telah memasang **Docker** dan **Docker Compose** (atau **Podman**).
2. Salin berkas konfigurasi `.env.example` ke `.env`:
   ```bash
   cp .env.example .env
   ```
3. Lakukan proses *build* dan jalankan kontainer:
   ```bash
   docker compose up -d --build
   ```
   Server akan mulai beroperasi di dalam kontainer Docker.

## Skrip Tersedia

- `npm run dev` : Menjalankan server dalam mode pengembangan.
- `npm run build` : Melakukan kompilasi kode TypeScript ke dalam folder `dist`.
- `npm run start` : Menjalankan server produksi dari folder `dist`.
- `npm test` : Menjalankan semua *unit testing* dan integrasi menggunakan Jest.
- `npm run typecheck` : Memeriksa tipe kode aplikasi dan tes.
- `npm run lint` : Melakukan pengecekan kode (Linting) dengan ESLint.
- `npm run format` : Melakukan pemformatan kode dengan Prettier.

## Brave Search

- `GET /api/brave/search?q=kata+kunci&num=5` memakai Brave Search API. Isi `BRAVE_SEARCH_API_KEY` pada `.env`; parameter `num` menerima 1–20 hasil.

## Player audio WebSocket

Kotonehara dapat memakai `.playws <judul atau link YouTube>` untuk mengirim kartu
rich HTML dengan tombol putar/jeda dan posisi lagu langsung di WhatsApp.
HTTP API, halaman player, dan WebSocket berjalan dalam satu proses dan port Hararest.

| Endpoint | Fungsi |
| --- | --- |
| `POST /api/player/sessions` | Body JSON `{"query":"judul lagu","baseUrl":"https://api.example.com"}`; mencari/menyiapkan audio lalu mengembalikan HTTP 201 dengan metadata, `html`, `wsUrl`, `playerUrl`, dan `expiresAt` di dalam `data` |
| `GET /player/:id` | Halaman player untuk sesi tersebut; HTTP 410 bila sesi tidak ditemukan atau kedaluwarsa |
| `WS /ws/player/:id` | Mengirim metadata `start`, frame audio biner, lalu `end`; sesi tidak tersedia ditolak sebelum upgrade |

Kotonehara mengirim origin `BASEAPI_URL` sebagai `baseUrl`. Misalnya API
`https://api.example.com` menghasilkan WS `wss://api.example.com/ws/player/...`.
Jika `baseUrl` tidak diberikan, Hararest memakai origin permintaan HTTP. Tidak
perlu domain atau port tambahan. `PLAYER_PUBLIC_URL` merupakan override opsional
jika bot mengakses API internal, sementara perangkat penerima memakai alamat publik.
Alamat player harus dapat diakses perangkat penerima. Untuk HTTPS, reverse proxy
perlu meneruskan WebSocket Upgrade pada `/ws/player/` dan memberi endpoint
penyiapan audio waktu tunggu hingga 10 menit. Koneksi HTTP lokal menggunakan `ws://`.

Setiap kartu memiliki sesi acak sendiri. Sesi disimpan dalam memori selama 30 menit
dan hilang saat proses direstart. Batas default: 8 sesi, 2 penyiapan bersamaan,
24 MiB/audio, durasi 10 menit, 16 koneksi WS total dan 4 per sesi. Link sesi dapat
dipakai siapa pun yang memilikinya hingga kedaluwarsa. File unduhan sementara
dihapus sesudah dibaca, termasuk saat hasil ditolak. Koneksi yang terputus saat
penyiapan membatalkan subprocess melalui `AbortSignal`.

Protokol WS: pesan JSON `start` memuat `totalChunks`, `size`, dan `mimeType`.
Setiap frame biner berisi indeks 4 byte unsigned big-endian (mulai dari 0), diikuti
maksimal 65.536 byte audio. JSON `end` menandai akhir transfer. Player memvalidasi
ukuran/jumlah/indeks, menggabungkan audio menjadi Blob, lalu mulai memutarnya.
Pemutaran menunggu transfer selesai; ini bukan pemutaran progresif/live stream.

Tes browser lokal (memerlukan FFmpeg dan Chrome/Chromium):

```bash
npm run test:player-browser
```

Tes menggunakan MP3 buatan lokal, HTTP/WS nyata, dan Chromium; tidak menghubungi
WhatsApp atau YouTube. Cakupannya meliputi playback, pause/seek/resume, penolakan
autoplay, klik ganda, data rusak/tidak lengkap, koneksi putus, serta cleanup Blob.
Untuk pengujian dengan WhatsApp, renderer penerima tetap perlu mendukung rich HTML,
JavaScript, koneksi WS, dan audio.

## Validasi dan pengujian

Jalankan `npm run typecheck`, `npm run lint`, `npm test -- --runInBand`, lalu `npm run build`.
Tes memakai fixture/mocks untuk layanan eksternal; kelulusan tes tidak menjamin scraper
pihak ketiga sedang tersedia. Konfigurasi produksi tidak menyertakan berkas tes di `dist`.

Parameter query harus berupa satu string yang tidak kosong, kecuali `quality=` pada
endpoint audio/video YouTube yang diperlakukan sebagai kualitas default untuk
kompatibilitas client lama. Client baru sebaiknya menghilangkan parameter kualitas
yang tidak dipilih. `limit` pencarian YouTube
menerima 1–10, `num` Brave 1–20, dan `limit` Danbooru 1–200; nilai di luar rentang
menghasilkan HTTP 400. Kualitas YouTube memakai resolusi seperti `360p` atau `720p`.
Threads menerima domain `threads.net` dan `threads.com`. Endpoint unduhan YouTube
menghasilkan satu file per permintaan, termasuk ketika URL berisi parameter playlist.

OCR menerima body biner JPEG, PNG, atau WebP (maksimal 15 MiB) di `POST /api/ocr`.
Pastikan `tesseract --list-langs` menampilkan `ind` dan `eng` pada instalasi lokal.
Dockerfile sudah memasang FFmpeg dan Tesseract beserta kedua bahasa tersebut.

Facebook mencoba extractor yt-dlp jika FDown gagal. Pastikan `YTDLP_PATH` menunjuk
ke executable yang tersedia; image Docker sudah mengonfigurasikannya. Beri client
timeout yang cukup untuk kedua extractor (hingga 240 detik).

Ketersediaan scraper bergantung pada akses upstream dan posting yang masih tersedia.
TikTok search/user feed dapat ditolak Cloudflare; Xiaohongshu dapat memerlukan
share link terbaru atau login. HTTP 502 menandakan kegagalan upstream. Limiter
operasi scraper membatasi sepuluh permintaan per menit per IP, bersama lintas modul.
