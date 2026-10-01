# Aset Arunika

Dibuat menggunakan tool bawaan `image_gen`, satu pemanggilan per aset, kemudian dikonversi dari PNG ke WebP **lossless**, tanpa resize atau pengubahan gambar. Alpha transparan dipertahankan. Katalog mencakup **60 karakter, 100 spesies musuh untuk level 1–999, dan 10 arena wilayah**. Aset dipakai langsung oleh koleksi, gacha, detail karakter, battle, dan peta pada `public/rpg/game.js`.

[manifest.json](manifest.json) menyimpan nama, ID, wilayah, path, status, dan prompt tiap aset. [index.json](index.json) adalah pemetaan ringkas yang dibaca game. Enam gambar awal berada di `v1`; 164 gambar tambahan berada di `v2`. Catatan `provenance/<id>.json` menyimpan prompt, nama PNG asli, dimensi, alpha, dan SHA-256 hasil impor. PNG asli tetap disimpan di folder keluaran tool, di luar repository.

Jangan menimpa berkas dalam direktori versi: gambar disajikan dengan cache immutable. Buat versi baru bila menggantinya, lalu ubah index dan manifest. Index selalu memakai `no-store`. Kartu di luar layar menggunakan lazy loading.

Jalankan `node scripts/rpg-art-audit.cjs` dari root Hararest untuk memeriksa jumlah, keunikan ID/path, kecocokan index, berkas, alpha, dan hash. `--finalize` memperbarui status menjadi `generated` hanya setelah seluruh pemeriksaan lulus. Impor keluaran baru melalui `node scripts/rpg-art-import.cjs <id> <path-png>`; importer menolak menimpa gambar yang sudah ada.

## Arsip prompt enam aset awal

Prompt asli paket `v1` dipertahankan di bawah ini. Prompt generasi paket `v2` tersedia lengkap per ID di manifest.

| Aset               | Berkas                                       |
| ------------------ | -------------------------------------------- |
| Arena Padang Embun | [v1/padang-embun.webp](v1/padang-embun.webp) |
| Ranu Pendar        | [v1/char_001.webp](v1/char_001.webp)         |
| Nira Gelagah       | [v1/char_002.webp](v1/char_002.webp)         |
| Luma Kincir        | [v1/char_004.webp](v1/char_004.webp)         |
| Wanu Telagakaca    | [v1/char_023.webp](v1/char_023.webp)         |
| Gumpal Embun       | [v1/enemy_001.webp](v1/enemy_001.webp)       |

## Prompt latar

Use case: stylized-concept. Asset type: finished landscape background for a mobile pixel-art JRPG battle arena called HARA: Gema Arunika. Generate ONE background illustration, wide landscape 1536x1024. Scene: Padang Embun, a quiet grassy clearing at dawn in a floating-island world; mossy small broken stone lantern shrine at the far back, fern silhouettes at the edges, warm amber light filtering through forest trees, tiny fireflies, misty teal distant trees, subdued olive grass foreground. Composition: distant scenery and trees concentrated in upper half and outer edges; bottom half a flat, mostly open grassy battlefield with low visual detail where sprites will be overlaid. Crisp intentional pixel art with coherent blocky pixel grid, limited rich olive/teal/ochre palette, no gradients or blur, charming classic 16-bit JRPG environment, detailed foliage but readable quiet arena. No people, no creatures, no UI, no lettering, no logos or watermark. Save the final generated image for integration into the local game project.

## Prompt karakter

Satu pemanggilan tool per karakter. Template berikut dipakai dengan `{subject}` dari daftar di bawah:

Use case: stylized-concept. Asset type: ONE transparent PNG battle sprite for pixel-art JRPG HARA: Gema Arunika. Subject: {subject} Full body adult chibi proportions around three heads tall. Side view in neutral ready battle pose, facing RIGHT. Entire figure and weapon must fit inside canvas with generous transparent margin, feet aligned at bottom. Authentic crisp limited-palette 16-bit pixel art, clean dark olive outlines, warm amber highlights, visually legible at only 64 pixels tall, consistent large square pixels, no anti-alias gradients. One single isolated character only. Truly transparent background with alpha; no scenery, no ground, no text, no frames, no contact shadow, no sprite sheet. Square 1024x1024 canvas. Give the character a clear unique silhouette matching their equipment.

- `char_001`: Ranu Pendar, a young adult spear fighter with copper braid, short grass-green cape, a red-wick spear topped with one small cracked lantern eye.
- `char_002`: Nira Gelagah, an adult guardian wearing a pale blue raincoat, holding a large round woven reed shield, a small dew bottle at the waist.
- `char_004`: Luma Kincir, an adult earth mage in a four-bladed windmill hat, carrying a stone pestle staff, wearing a patchwork terracotta skirt.
- `char_023`: Wanu Telagakaca, an adult healer with a turquoise jug-shaped staff, flowing layered wet-fabric teal cloak and a glass droplet necklace.

## Prompt musuh

Create ONE finished transparent PNG enemy sprite for a pixel-art JRPG. A small round living turquoise water slime named Gumpal Embun, green leaf eyebrows, one golden seed visible inside its jelly body, expressive cute battle-ready face oriented to the RIGHT. Full body isolated centered with generous transparent margins, no shadow or scenery. Crisp coherent 16-bit pixel art, dark olive outlines and warm amber highlights, clear silhouette readable at 64px. Square image, genuine alpha transparency. No text, logos, UI, watermark, frames or sprite sheet.
