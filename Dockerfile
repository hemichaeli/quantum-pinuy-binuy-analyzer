# Railway Dockerfile with Chromium for Puppeteer v4.8.5
# Using full node:18 (not slim) for better Chromium compatibility
FROM node:18-bookworm
# Install Chromium and all required dependencies
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       chromium \
       fonts-liberation \
       fonts-noto-color-emoji \
       fonts-noto-cjk \
       libatk-bridge2.0-0 \
       libatk1.0-0 \
       libcups2 \
       libdrm2 \
       libgbm1 \
       libgtk-3-0 \
       libnspr4 \
       libnss3 \
       libx11-xcb1 \
       libxcomposite1 \
       libxdamage1 \
       libxfixes3 \
       libxrandr2 \
       libxshmfence1 \
       xdg-utils \
    && rm -rf /var/lib/apt/lists/* \
    && chromium --version
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV CHROMIUM_PATH=/usr/bin/chromium
WORKDIR /app
# Force full rebuild - no layer cache - 20260311095615
COPY . .
RUN npm install --omit=dev
# Build-time patches (v4.24.2): fix column names in weeklyScanner kones query
RUN sed -i "s/SELECT id, name, city, street, address FROM complexes/SELECT id, name, city, neighborhood, addresses FROM complexes/" src/jobs/weeklyScanner.js
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1
CMD ["npm", "start"]
