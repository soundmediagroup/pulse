FROM node:20-slim

WORKDIR /app

# Install build tools needed for better-sqlite3 native module
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    unzip \
    && rm -rf /var/lib/apt/lists/*

# Install dependencies FIRST (this layer is cached unless package.json changes)
COPY package*.json ./
RUN npm ci --omit=dev

# Copy pre-built app output (changes every deploy, but npm layer is cached)
COPY dist/ ./dist-source/
COPY dist/ ./dist/
COPY entrypoint.sh ./
RUN chmod +x entrypoint.sh

VOLUME ["/app/data"]

ENV NODE_ENV=production
ENV PORT=5000
ENV DB_PATH=/app/data/cadence_tracker.db

EXPOSE 5000

ENTRYPOINT ["/app/entrypoint.sh"]
