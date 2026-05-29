FROM node:22-bookworm

# Install system dependencies
RUN apt-get update && apt-get install -y \
    ffmpeg \
    curl \
    python3 \
    python3-pip \
    python3-venv \
    chromium \
    && rm -rf /var/lib/apt/lists/*

# Python env for Instagram SnapInsta fallback
RUN python3 -m venv /opt/instagram-fallback && \
    /opt/instagram-fallback/bin/pip install --no-cache-dir cloudscraper==1.2.71

# Install yt-dlp
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp && \
    chmod a+rx /usr/local/bin/yt-dlp

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

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
# Default port, can be overridden
ENV PORT=1337 

# Expose the port
EXPOSE 1337

# Start the application
CMD ["npm", "start"]
