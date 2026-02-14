# =============================================================================
# Klaviyo Flow Builder — Docker Image for Render Deployment
# =============================================================================
# Includes: Node.js, Sharp, Playwright + Chromium
# =============================================================================

FROM node:20-slim

# Install system dependencies for Playwright/Chromium + Sharp
RUN apt-get update && apt-get install -y \
    wget \
    ca-certificates \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
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
    libpango-1.0-0 \
    libcairo2 \
    libgdk-pixbuf2.0-0 \
    libvips-dev \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --production=false

# Install Playwright Chromium
ENV PLAYWRIGHT_BROWSERS_PATH=/app/.playwright-browsers
RUN npx playwright install chromium

# Copy source code
COPY . .

# Build TypeScript
RUN npm run build

# Set environment for production
ENV NODE_ENV=production
ENV HEADLESS=true
ENV PORT=3000

# Expose port
EXPOSE 3000

# Start the web server
CMD ["node", "dist/server.js"]
