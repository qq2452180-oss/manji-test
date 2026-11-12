# Build browser assets on the builder's native architecture.
FROM --platform=$BUILDPLATFORM node:24.15.0-bookworm-slim AS web

WORKDIR /build/src/web
COPY src/web/package.json src/web/package-lock.json ./
RUN npm ci
COPY src/web/ ./
RUN npm run build

FROM python:3.11.17-slim-bookworm AS app

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    MANJI_LANGGRAPH_MEDIA_DIRECTORY=/app/data/media

WORKDIR /app
COPY requirements.txt ./requirements.txt
RUN python -m pip install -r requirements.txt \
    && python -m pip check

RUN groupadd --gid 10001 manji \
    && useradd --uid 10001 --gid 10001 --no-create-home manji \
    && mkdir -p /app/data/media \
    && chown 10001:10001 /app/data/media

COPY src/__init__.py src/main.py ./src/
COPY src/api/ ./src/api/
COPY src/common/ ./src/common/
COPY src/langgraph/ ./src/langgraph/
COPY src/service/ ./src/service/
COPY --from=web /build/src/web/dist/ ./src/web/dist/

USER 10001:10001
EXPOSE 8000

# Readiness includes the database schema and the built frontend assets.
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
    CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/ready', timeout=8).read()"]

# Keep this port on the private Compose network behind the trusted gateway.
# RTC call state requires a single worker.
CMD ["python", "-m", "uvicorn", "src.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1", "--proxy-headers", "--forwarded-allow-ips", "*"]
