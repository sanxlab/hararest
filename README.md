# Hararest

Hararest adalah aplikasi backend API untuk mengunduh media dari berbagai platform sosial media seperti YouTube, Instagram, Facebook, TikTok, Threads, dan Xiaohongshu. Proyek ini dibangun menggunakan Node.js (Express), TypeScript, serta memiliki fallback *scraper* menggunakan skrip Python.

## Persyaratan Sistem

Sebelum melakukan instalasi, pastikan sistem Anda telah terpasang perangkat lunak berikut:

- **Node.js** (direkomendasikan versi 18 atau 20+)
- **npm** (biasanya sudah termasuk dengan instalasi Node.js)
- **Python** (versi 3.8+ untuk menjalankan skrip *scraper* fallback)
- **Google Chrome** atau **Chromium** (diperlukan untuk fitur Puppeteer)
- **yt-dlp** (diperlukan untuk mengunduh video YouTube)

## Cara Instalasi (Pengembangan Lokal)

1. **Clone repositori ini:**
   ```bash
   git clone git@github.com:sanxlab/hararest.git
   cd hararest
   ```

2. **Instal dependensi Node.js:**
   ```bash
   npm install
   ```

3. **Persiapkan dependensi Python:**
   Aplikasi membutuhkan library Python tertentu untuk fungsi *scraper* fallback (Instagram & Facebook). Anda disarankan untuk membuat *virtual environment*:
   ```bash
   python -m venv venv
   source venv/bin/activate  # Untuk Linux/macOS
   # atau venv\Scripts\activate untuk Windows

   pip install cloudscraper yt-dlp
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
- `npm run lint` : Melakukan pengecekan kode (Linting) dengan ESLint.
- `npm run format` : Melakukan pemformatan kode dengan Prettier.
