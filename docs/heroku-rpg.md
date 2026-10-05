# RPG gateway di Heroku

Hararest tetap berjalan sebagai `web` pada `PORT` yang diberikan Heroku. Browser membuka domain Hararest; gateway meneruskan API melalui HTTPS ke aplikasi Kotonehara yang juga berjalan sebagai satu dyno `web`.

```text
Pemain → https://api.oohara.dev/rpg/ → Hararest
       → https://<domain-aplikasi-kotonehara>/rpg/api/... → PostgreSQL bot
```

## Config Vars Hararest

```dotenv
RPG_UPSTREAM_URL=https://<domain-aplikasi-kotonehara>
RPG_GATEWAY_SECRET=<secret acak yang sama dengan bot>
```

Gunakan origin HTTPS aplikasi **bot**, tanpa path `/rpg/api`. Jangan isi upstream dengan domain Hararest sendiri. Generate secret sekali (`openssl rand -hex 32`) dan simpan pada kedua aplikasi lewat Config Vars. Jangan commit secret ke repository.

## Config Vars Kotonehara

```dotenv
DB_DRIVER=postgres
DATABASE_URL=<koneksi PostgreSQL bot yang sudah dipakai>
RPG_ENABLED=true
RPG_PUBLIC_URL=https://api.oohara.dev
RPG_GATEWAY_SECRET=<secret yang sama dengan Hararest>
```

`RPG_PUBLIC_URL` adalah origin **Hararest** yang dibuka pemain, tanpa `/rpg`. `RPG_LISTEN_ADDR` adalah alamat bind server bot, bukan URL publik. Kode bot memakai `0.0.0.0:<PORT>` otomatis ketika Heroku memberikan `PORT`; jangan menetapkan port Heroku sendiri atau menulis `$PORT` literal di Config Vars.

Bot harus memakai versi yang mendukung PostgreSQL dan deployment web. Workflow main bot memvalidasi config, menghentikan worker/web lama, release image web, lalu menjalankan satu `web=1`. Ada jeda layanan singkat agar sesi WhatsApp tidak berjalan ganda. Jangan menyalakan worker bersamaan dengan web. Tidak ada perubahan otomatis pada Config Vars/database production; RPG default tetap nonaktif sampai dikonfigurasi.

Data RPG SQLite dev tidak otomatis dipindahkan ke PostgreSQL. SQLite pada filesystem dyno tidak persisten; pertahankan PostgreSQL production yang sudah berisi data bot. Detail perpindahan dan pemulihan ada di `docs/heroku-rpg.md` repo Kotonehara.

## Verifikasi

1. Deploy versi bot dengan dukungan PostgreSQL/web dan isi env RPG pada kedua aplikasi.
2. Periksa `https://<domain-aplikasi-kotonehara>/health`: `status: ok`, `rpg_enabled: true`. Health ini bukan pemeriksaan login WhatsApp.
3. Permintaan langsung ke API bot tanpa gateway secret harus mendapat 401.
4. Kirim `.rpg lanjut` pada bot. Link harus memakai domain Hararest. Buka link pribadi, lalu coba profil, gacha dan battle.

Browser hanya berkomunikasi dengan Hararest; cookie login tetap berada pada domain Hararest. Gateway meneruskan cookie/origin/CSRF dan menambahkan secret sendiri. Pemain tidak perlu Tailscale untuk jalur HTTPS production ini.

Dev VPS tetap memakai `RPG_UPSTREAM_URL=http://kotonehara-dev:8089`, `RPG_PUBLIC_URL=http://100.89.85.96:1338`, dan listener bot `0.0.0.0:8089`. Workflow dev/self-hosted dan main/Heroku tetap terpisah; membuka PR tidak menjalankan deployment.

Referensi: [Heroku container runtime](https://devcenter.heroku.com/articles/container-registry-and-runtime), [port web dyno](https://devcenter.heroku.com/articles/dyno-startup-behavior), [filesystem dyno](https://devcenter.heroku.com/articles/dyno-isolation).
