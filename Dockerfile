FROM python:3.12-slim

# ffmpeg merges separate video/audio streams and handles HLS videos.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY bot.py downloader.py ui.py web.py ./
COPY static ./static
COPY assets/avatar.png assets/banner.png assets/banner-en.png ./assets/

ENV PYTHONUNBUFFERED=1
EXPOSE 8000
# The bot by default; docker-compose.yml runs the website from the same image.
CMD ["python", "bot.py"]
