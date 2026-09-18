# Deploy Hararest ke Heroku lewat GitHub Actions

Workflow `.github/workflows/ci.yml` memeriksa tipe, tes, lint, dan build pada PR
serta push ke `main`. Setelah lolos, workflow membuat image `linux/amd64` dan
menguji `/health` sebagai user non-root dengan port dinamis serta cookie dummy.
Hanya push ke `main` yang kemudian mengirim **image yang sama** ke
`registry.heroku.com/<app>/web` dan menjalankan `heroku container:release web`.
`workflow_dispatch` hanya menjalankan pemeriksaan, tanpa deploy.

## Konfigurasi satu kali

1. Buat aplikasi Heroku **Cedar** untuk dyno Basic dengan stack `container`, atau
   ubah stack aplikasi yang sudah ada:

   ```bash
   heroku stack:set container --app NAMA_APP
   ```

2. Di repo GitHub, buka **Settings → Secrets and variables → Actions**. Tambahkan
   repository secrets `HEROKU_API_KEY` (token Heroku) dan `HEROKU_APP_NAME` (nama
   aplikasi Hararest, bukan aplikasi bot). Workflow mengikuti pola Kotonehara,
   tetapi merilis proses `web`, bukan `worker`.

3. Di **Heroku → Settings → Config Vars**, isi konfigurasi runtime yang diperlukan:

   | Config Var | Nilai |
   | --- | --- |
   | `BILIBILI_SESSDATA` | Nilai SESSDATA saja, tanpa `SESSDATA=` atau header Cookie |
   | `YTDLP_COOKIES_BASE64` | Isi file cookies YouTube format Netscape yang di-base64 |
   | `YTDLP_POT_PROVIDER_URL` | Opsional: URL server PO token yang bisa diakses dari Heroku |
   | `BRAVE_SEARCH_API_KEY` | API key Brave bila memakai fitur pencarian |
   | `TRUST_PROXY_HOPS` | `1`, untuk membaca IP client melalui router Heroku |
   | `PLAYER_PUBLIC_URL` | Opsional: origin HTTPS publik, misalnya `https://api.example.com` |

   Jangan salin seluruh `.env` lokal. Image sudah menentukan `YTDLP_PATH`,
   `PYTHON_BIN`, lokasi skrip Python, dan `TMP_DIR=/tmp/hararest`. Jangan override
   dengan path komputer lokal. Biarkan Heroku menentukan `PORT`.

4. Push ke `main`. Setelah release pertama berhasil, aktifkan satu dyno Basic:

   ```bash
   heroku ps:scale web=1:basic --app NAMA_APP
   ```

5. Cek `https://<domain-heroku>/health`, lalu ubah `BASEAPI_URL` pada Kotonehara
   ke domain Hararest yang baru. Cookie dan SESSDATA tetap berada di Hararest.

## Migrasi cookies

File lokal dyno bersifat sementara. Mengunggah cookie ke satu dyno lewat terminal
tidak membuatnya tersedia setelah restart/deploy atau pada dyno lain. Cookie
tidak dimasukkan ke Git, build arguments, image Docker, atau GitHub Actions.

Untuk menyiapkan nilai Config Var tanpa mencetak cookie di log, jalankan di mesin
lokal (Linux):

```bash
umask 077
base64 -w 0 cookies/yt-dlp_cookies.txt > youtube.cookies.base64
```

Salin isi file tersebut melalui editor lokal ke `YTDLP_COOKIES_BASE64` di dashboard
Heroku. File `*.cookies.base64` sudah diabaikan Git dan konteks build Docker.
Hapus salinan sementara setelah selesai. Base64 adalah encoding, bukan enkripsi.
Gunakan ekspor cookies YouTube yang diperlukan saja, bukan seluruh cookie browser.
Total semua Config Vars Heroku dibatasi **64 KB**, termasuk nilai base64.

Saat aplikasi mulai, cookie divalidasi lalu ditulis ulang ke direktori privat
di `/tmp` dengan izin file `0600`. `YTDLP_COOKIES_BASE64` mengalahkan
`YTDLP_COOKIES_PATH`; jika kosong, metode file/mount Docker Compose tetap bekerja.
Nilai yang rusak membuat startup gagal dengan pesan tanpa isi cookie.

Saat cookie kedaluwarsa, ekspor ulang dan ganti Config Var. Heroku merestart dyno
setelah perubahan Config Vars, sehingga cookie baru dimuat tanpa build image.
Perubahan cookie yang dibuat yt-dlp selama runtime tidak disimpan kembali ke
Config Vars. Migrasi IP juga dapat memicu verifikasi upstream; cookie tidak
menjamin akses dari jaringan Heroku.

`BILIBILI_SESSDATA` tidak perlu base64 atau file; konfigurasi yang sama tetap
tersedia di setiap release. `INSTAGRAM_COOKIE_FILE` pada contoh `.env` lama
belum dibaca scraper Instagram saat ini, sehingga menyalinnya tidak mengaktifkan
login Instagram.

## Perbedaan dengan Docker Compose

- Heroku menjalankan image Hararest saja, bukan `compose.yml`. Layanan
  `bgutil-provider` perlu tetap dijalankan terpisah bila YouTube memerlukannya.
  Isi `YTDLP_POT_PROVIDER_URL` dengan alamat yang dapat dijangkau Heroku.
  Tanpa konfigurasi ini, tidak ada server PO token yang disediakan deployment.
- Log produksi dikirim ke stdout/stderr dan dibaca melalui `heroku logs --tail`.
- Job, file hasil unduhan, dan sesi player masih lokal pada proses/dyno. Gunakan
  **satu dyno web**; restart/deploy menghilangkan job dan file yang belum diambil.
- Untuk ekstraksi YouTube yang lama, gunakan endpoint job agar tidak menunggu
  ekstraksi selesai dalam satu request HTTP Heroku.

Referensi: [Container Registry & Runtime](https://devcenter.heroku.com/articles/container-registry-and-runtime),
[Config Vars](https://devcenter.heroku.com/articles/config-vars).
