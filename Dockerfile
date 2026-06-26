FROM node:22-bookworm

# Install system dependencies, including Chromium for puppeteer-core.
RUN apt-get update && apt-get install -y \
    ffmpeg \
    curl \
    python3 \
    python3-pip \
    python3-venv \
    chromium \
    && rm -rf /var/lib/apt/lists/*

# Python env for Instagram/Facebook fallback scrapers
RUN python3 -m venv /opt/instagram-fallback && \
    /opt/instagram-fallback/bin/pip install --no-cache-dir cloudscraper==1.2.71

# Install yt-dlp together with the BgUtils PO Token provider plugin. Keeping both
# in the same virtual environment lets yt-dlp discover the plugin at runtime.
RUN python3 -m venv /opt/yt-dlp && \
    /opt/yt-dlp/bin/pip install --no-cache-dir --upgrade \
        'yt-dlp>=2025.05.22' \
        bgutil-ytdlp-pot-provider && \
    ln -s /opt/yt-dlp/bin/yt-dlp /usr/local/bin/yt-dlp

RUN printf '%s\n' \
    '--js-runtimes node' \
    '--remote-components ejs:github' \
    '--extractor-args youtubepot-bgutilhttp:base_url=http://bgutil-provider:4416' \
    > /etc/yt-dlp.conf

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV CHROME_PATH=/usr/bin/chromium

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy source code
COPY . .

# Build the application
RUN npm run build

# Set environment variables
ENV NODE_ENV=production
ENV YTDLP_PATH=/usr/local/bin/yt-dlp
ENV PYTHON_BIN=/opt/instagram-fallback/bin/python
ENV INSTAGRAM_FALLBACK_PYTHON_SCRIPT=/app/src/modules/instagram/snapinsta_scraper.py
ENV FACEBOOK_FALLBACK_PYTHON_SCRIPT=/app/src/modules/facebook/fdown_scraper.py
ENV INSTAGRAM_COOKIE_FILE=/app/cookies/www.instagram.com_cookies.txt
ENV YTDLP_COOKIES_PATH=/app/cookies/yt-dlp_cookies.txt
# Default port, can be overridden
ENV PORT=1337 

# Mount Instagram cookies here at runtime instead of baking them into the image.
VOLUME ["/app/cookies"]

# Expose the port
EXPOSE 1337

# Start the application
CMD ["npm", "start"]
