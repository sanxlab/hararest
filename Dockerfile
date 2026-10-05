FROM node:22-bookworm AS builder

WORKDIR /app

# Build node-canvas if a prebuilt binary is unavailable for the target platform.
RUN apt-get update && apt-get install -y --no-install-recommends \
    libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
ENV PUPPETEER_SKIP_DOWNLOAD=true
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm AS runtime

# Runtime system dependencies:
# - ffmpeg: audio/video conversion for yt-dlp
# - python3/venv: Python fallback scrapers and yt-dlp isolated installs
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    python3 \
    python3-venv \
    tesseract-ocr \
    tesseract-ocr-ind \
    tesseract-ocr-eng \
    libcairo2 libpango-1.0-0 libpangocairo-1.0-0 libjpeg62-turbo libgif7 librsvg2-2 \
    fonts-noto-core fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*

# Python env for Instagram/Facebook fallback scrapers.
RUN python3 -m venv /opt/media-fallback && \
    /opt/media-fallback/bin/pip install --no-cache-dir cloudscraper==1.2.71

# Install yt-dlp together with the BgUtils PO Token provider plugin. Keeping both
# in the same virtual environment lets yt-dlp discover the plugin at runtime.
RUN python3 -m venv /opt/yt-dlp && \
    /opt/yt-dlp/bin/pip install --no-cache-dir --upgrade \
        'yt-dlp[default]>=2025.05.22' \
        bgutil-ytdlp-pot-provider && \
    ln -s /opt/yt-dlp/bin/yt-dlp /usr/local/bin/yt-dlp

RUN printf '%s\n' \
    '--js-runtimes node' \
    '--remote-components ejs:github' \
    > /etc/yt-dlp.conf

WORKDIR /app

COPY package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY vendor ./vendor
COPY public ./public

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/src/modules/instagram/snapinsta_scraper.py ./src/modules/instagram/snapinsta_scraper.py
COPY --from=builder /app/src/modules/facebook/fdown_scraper.py ./src/modules/facebook/fdown_scraper.py

ENV NODE_ENV=production
ENV YTDLP_PATH=/usr/local/bin/yt-dlp
ENV PYTHON_BIN=/opt/media-fallback/bin/python
ENV INSTAGRAM_FALLBACK_PYTHON_SCRIPT=/app/src/modules/instagram/snapinsta_scraper.py
ENV FACEBOOK_FALLBACK_PYTHON_SCRIPT=/app/src/modules/facebook/fdown_scraper.py
ENV YTDLP_COOKIES_PATH=/app/cookies/yt-dlp_cookies.txt
ENV TMP_DIR=/tmp/hararest
ENV PORT=1337

# Mount cookies here at runtime instead of baking them into the image.
VOLUME ["/app/cookies"]

# Create logs directory for winston-daily-rotate-file
RUN mkdir -p /app/logs && chown -R node:node /app

# Run as non-root user for security (node user is built-in to the node image)
USER node

EXPOSE 1337

CMD ["node", "dist/server.js"]
