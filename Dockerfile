# Stage 1: Build React frontend
FROM node:22-alpine AS frontend-builder
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# Stage 2: Build Rust backend
FROM rust:bookworm AS backend-builder
WORKDIR /app/backend

# Cache dependencies first
COPY backend/Cargo.toml backend/Cargo.lock ./
RUN mkdir -p src && echo "fn main() {}" > src/main.rs && cargo build --release && rm -rf src

# Build actual backend binary
COPY backend/src ./src
COPY backend/migrations ./migrations
RUN rm -f target/release/trip-agent-backend target/release/deps/trip_agent_backend* \
    && touch src/main.rs \
    && cargo build --release

# Stage 3: Minimal runtime image
FROM debian:bookworm-slim AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=backend-builder /app/backend/target/release/trip-agent-backend /app/trip-agent-backend
COPY --from=frontend-builder /app/frontend/dist /app/frontend/dist

RUN mkdir -p /app/data/audio

ENV HOST=0.0.0.0 \
    PORT=3001 \
    DATABASE_URL=sqlite://data/trip_agent.db?mode=rwc \
    AUDIO_CACHE_DIR=data/audio \
    STATIC_DIR=/app/frontend/dist

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -fsS http://127.0.0.1:3001/api/health || exit 1

CMD ["/app/trip-agent-backend"]
