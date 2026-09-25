# Hararest

Hararest adalah aplikasi backend API untuk mengunduh media dari berbagai platform sosial media seperti YouTube, Instagram, Facebook, TikTok, Threads, Xiaohongshu, dan Bilibili. Proyek ini dibangun menggunakan Node.js (Express), TypeScript, serta memiliki fallback *scraper* menggunakan skrip Python.

## Persyaratan Sistem

Sebelum melakukan instalasi, pastikan sistem Anda telah terpasang perangkat lunak berikut:

- **Node.js 22.12+**
- **npm** (biasanya sudah termasuk dengan instalasi Node.js)
- **Python** (versi 3.10+ untuk menjalankan skrip *scraper* fallback)
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
   Buka berkas `.env` dan sesuaikan konfigurasi layanan yang dipakai. Server tidak memerlukan Chrome/Chromium.

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

Panduan CI/CD container, GitHub Secrets, dan migrasi cookies tersedia di
[Deploy ke Heroku](docs/heroku.md).
Deployment branch dev langsung ke Docker di VPS dijelaskan di
[Dev deployment on the VPS](docs/dev-vps.md). Push ke `main` akan deploy setelah
semua pemeriksaan dan smoke test container lulus jika secrets Heroku sudah diisi.

- `npm run dev` : Menjalankan server dalam mode pengembangan.
- `npm run build` : Melakukan kompilasi kode TypeScript ke dalam folder `dist`.
- `npm run start` : Menjalankan server produksi dari folder `dist`.
- `npm test` : Menjalankan semua *unit testing* dan integrasi menggunakan Jest.
- `npm run typecheck` : Memeriksa tipe kode aplikasi dan tes.
- `npm run lint` : Melakukan pengecekan kode (Linting) dengan ESLint.
- `npm run format` : Melakukan pemformatan kode dengan Prettier.

## RPG Kotonehara

Hararest menyajikan game di `/rpg/` dan meneruskan API ke service Go Kotonehara. Lihat [konfigurasi RPG, alur pemain, dan pengujian](docs/rpg/integration.md). Fitur memerlukan konfigurasi di kedua repo; tidak memakai Redis.

Untuk dev lewat Tailscale, set `RPG_PUBLIC_URL=http://100.89.85.96:1338` di env **Kotonehara**. Di env Hararest, gunakan `TAILSCALE_IP=100.89.85.96`, `RPG_UPSTREAM_URL=http://kotonehara-dev:8089`, dan `RPG_GATEWAY_SECRET` yang sama dengan bot. Pemain membuka `/rpg/` lewat port Hararest1338 dari perangkat yang terhubung ke tailnet; port8089 hanya untuk API internal bot. Alamat publik di luar tailnet tetap memakai HTTPS.

Tes browser pada HTTP Tailscale: `RPG_E2E_HOST=IP-TAILSCALE-MESIN-INI npm run test:rpg-browser`. Tes memakai database sementara dan tidak menyentuh akun bot.
