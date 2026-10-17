import axios from 'axios';
import * as cheerio from 'cheerio';
import sharp from 'sharp';
import { AppError } from '../../utils/AppError';
import { publicHttpAgent, publicHttpsAgent } from '../../utils/publicAgent';
import logger from '../../utils/logger';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const CIN_GURU_BASE = 'https://cin.guru';

interface PageImage {
  /** Full image URL */
  t: string;
  w: number;
  h: number;
}

interface GalleryData {
  id: number;
  media_id: string;
  title: {
    english: string;
    japanese: string;
    pretty: string;
  };
  images: {
    cover: PageImage;
    pages: PageImage[];
    thumbnail: PageImage;
  };
  tags: Array<{ type: string; name: string }>;
  num_pages: number;
}

/** Scrape cin.guru/v/{id} and extract gallery data from __NEXT_DATA__. */
export async function fetchGalleryData(id: string): Promise<GalleryData> {
  const url = `${CIN_GURU_BASE}/v/${encodeURIComponent(id)}`;
  let html: string;
  try {
    const resp = await axios.get<string>(url, {
      adapter: 'http',
      responseType: 'text',
      transformResponse: [(body: string) => body],
      timeout: 20000,
      maxContentLength: 2 * 1024 * 1024,
      maxRedirects: 3,
      proxy: false,
      httpAgent: publicHttpAgent,
      httpsAgent: publicHttpsAgent,
      headers: { 'User-Agent': UA, Accept: 'text/html' },
    });
    html = resp.data;
  } catch {
    logger.error(`cin.guru fetch failed for id=${id}`);
    throw new AppError('Gagal mengambil halaman dari cin.guru.', 502);
  }

  const $ = cheerio.load(html);
  const nextDataScript = $('#__NEXT_DATA__').html();
  if (!nextDataScript) {
    throw new AppError('Struktur halaman cin.guru berubah, __NEXT_DATA__ tidak ditemukan.', 502);
  }

  let parsed: { props?: { pageProps?: { data?: GalleryData } } };
  try {
    parsed = JSON.parse(nextDataScript) as typeof parsed;
  } catch {
    throw new AppError('Gagal mem-parse data JSON dari cin.guru.', 502);
  }

  const gallery = parsed?.props?.pageProps?.data;
  if (!gallery || !gallery.images?.pages?.length) {
    throw new AppError('Data galeri tidak ditemukan atau kosong.', 404);
  }

  return gallery;
}

/** Download a single image and convert to JPEG buffer via sharp. */
async function downloadImage(imgUrl: string): Promise<Buffer> {
  const resp = await axios.get(imgUrl, {
    adapter: 'http',
    responseType: 'arraybuffer',
    timeout: 30000,
    maxContentLength: 20 * 1024 * 1024,
    maxRedirects: 3,
    proxy: false,
    httpAgent: publicHttpAgent,
    httpsAgent: publicHttpsAgent,
    headers: {
      'User-Agent': UA,
      Accept: 'image/webp,image/*',
      Referer: CIN_GURU_BASE,
    },
  });
  // Convert any format (webp, jpg, png) to JPEG for PDF compatibility
  return sharp(Buffer.from(resp.data as ArrayBuffer))
    .jpeg({ quality: 85 })
    .toBuffer();
}

// ────────────────────────────────────────────────────────────
// Minimal PDF writer – no external dependency required.
// Each page is sized to the image dimensions at 72 DPI.
// ────────────────────────────────────────────────────────────

function buildPdf(images: Buffer[]): Buffer {
  // Collect objects as strings; track byte offsets for xref.
  const objects: string[] = [];
  const push = (obj: string) => {
    objects.push(obj);
    return objects.length; // 1-based object number
  };

  // 1 – Catalog (placeholder, populated after pages)
  push(''); // slot 1
  // 2 – Pages (placeholder)
  push(''); // slot 2

  const pageObjNums: number[] = [];

  for (const imgBuf of images) {
    // Detect dimensions from JPEG SOF marker
    const dims = jpegDimensions(imgBuf);
    const w = dims.width;
    const h = dims.height;

    // Image XObject
    const imgObjNum = push(
      [
        `<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h}`,
        `/ColorSpace /DeviceRGB /BitsPerComponent 8`,
        `/Filter /DCTDecode /Length ${imgBuf.length} >>`,
      ].join(' '),
    );

    // Page content stream: draw image full-page
    const stream = `q ${w} 0 0 ${h} 0 0 cm /Img Do Q`;
    const contentObjNum = push(
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    );

    // Page object
    const pageObjNum = push(
      [
        `<< /Type /Page /Parent 2 0 R`,
        `/MediaBox [0 0 ${w} ${h}]`,
        `/Contents ${contentObjNum} 0 R`,
        `/Resources << /XObject << /Img ${imgObjNum} 0 R >> >> >>`,
      ].join(' '),
    );
    pageObjNums.push(pageObjNum);
  }

  // Now fill in catalog and pages
  const kids = pageObjNums.map((n) => `${n} 0 R`).join(' ');
  objects[0] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objects[1] = `<< /Type /Pages /Kids [${kids}] /Count ${pageObjNums.length} >>`;

  // Serialize
  const header = '%PDF-1.4\n';
  const parts: Buffer[] = [Buffer.from(header)];
  let offset = header.length;
  const offsets: number[] = [];

  for (let i = 0; i < objects.length; i++) {
    const obj = objects[i];
    const num = i + 1;
    // Check if this object contains a JPEG stream (image XObject)
    const isImage = obj.includes('/DCTDecode');

    if (isImage) {
      // Find the corresponding image buffer index.  Image objects are
      // pushed in order for each image, so we can derive the index.
      const imgIndex = pageObjNums.indexOf(num + 2); // page is +2 after image
      const imgBuf = images[imgIndex];

      const beforeStream = obj; // already ends with >>
      // Re-construct to embed binary data
      const pre = `${num} 0 obj\n`;
      const headerPart = beforeStream.replace(/ >>$/, '');
      const objBytes = Buffer.concat([
        Buffer.from(`${pre}${headerPart} >>\nstream\n`),
        imgBuf,
        Buffer.from('\nendstream\nendobj\n'),
      ]);
      offsets.push(offset);
      parts.push(objBytes);
      offset += objBytes.length;
    } else {
      const line = `${num} 0 obj\n${obj}\nendobj\n`;
      offsets.push(offset);
      parts.push(Buffer.from(line));
      offset += Buffer.byteLength(line);
    }
  }

  // xref
  const xrefOffset = offset;
  const xrefLines = ['xref', `0 ${objects.length + 1}`, '0000000000 65535 f \r'];
  for (const off of offsets) {
    xrefLines.push(`${String(off).padStart(10, '0')} 00000 n \r`);
  }
  const trailer = [
    'trailer',
    `<< /Size ${objects.length + 1} /Root 1 0 R >>`,
    'startxref',
    String(xrefOffset),
    '%%EOF',
    '',
  ].join('\n');

  parts.push(Buffer.from(xrefLines.join('\n') + '\n' + trailer));

  return Buffer.concat(parts);
}

function jpegDimensions(buf: Buffer): { width: number; height: number } {
  // Scan for SOFn markers (0xFF 0xC0..0xCF except 0xC4 and 0xC8)
  let i = 2; // skip SOI
  while (i < buf.length - 8) {
    if (buf[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = buf[i + 1];
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8) {
      const height = buf.readUInt16BE(i + 5);
      const width = buf.readUInt16BE(i + 7);
      return { width, height };
    }
    // Skip segment
    const segLen = buf.readUInt16BE(i + 2);
    i += 2 + segLen;
  }
  // Fallback
  return { width: 1280, height: 1791 };
}

/**
 * Fetch gallery from cin.guru, download all pages, and return a PDF buffer.
 * Downloads images with concurrency limit to avoid overwhelming the server.
 */
export async function generateNhentaiPdf(
  id: string,
): Promise<{ pdf: Buffer; title: string; pageCount: number }> {
  const gallery = await fetchGalleryData(id);
  const pages = gallery.images.pages;

  logger.info(`nhentai-pdf: downloading ${pages.length} pages for id=${id}`);

  // Download images with concurrency = 4
  const CONCURRENCY = 4;
  const imageBuffers: Buffer[] = new Array(pages.length);
  for (let batch = 0; batch < pages.length; batch += CONCURRENCY) {
    const slice = pages.slice(batch, batch + CONCURRENCY);
    const results = await Promise.all(
      slice.map((p) => downloadImage(p.t)),
    );
    for (let j = 0; j < results.length; j++) {
      imageBuffers[batch + j] = results[j];
    }
  }

  logger.info(`nhentai-pdf: building PDF for id=${id}`);
  const pdf = buildPdf(imageBuffers);

  return {
    pdf,
    title: gallery.title.pretty || gallery.title.english || `nhentai-${id}`,
    pageCount: pages.length,
  };
}
