# The product hunter's website and daily hunt. Built from the repository root:
#   docker compose -f docker-compose.hunter.yml up -d --build
FROM python:3.12-slim

WORKDIR /app
COPY hunter/requirements.txt ./hunter/requirements.txt
RUN pip install --no-cache-dir -r hunter/requirements.txt

COPY hunter ./hunter
# Everything the site keeps (database, backups) lives in /data, a volume.
RUN useradd --create-home --uid 10001 hunter && mkdir -p /data && chown hunter /data
USER hunter

ENV PYTHONUNBUFFERED=1 HUNTER_DB=/data/hunter.db HUNTER_BACKUPS=/data/backups
EXPOSE 8100
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8100/healthz', timeout=4)"
CMD ["python", "-m", "hunter", "serve", "--port", "8100"]
