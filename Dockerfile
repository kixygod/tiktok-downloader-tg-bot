FROM python:3.11-slim

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Установка v2ray-core
RUN apt-get update && apt-get install -y curl unzip && \
  curl -L https://github.com/v2fly/v2ray-core/releases/latest/download/v2ray-linux-64.zip -o v2ray.zip && \
  unzip v2ray.zip -d /usr/bin/ && \
  chmod +x /usr/bin/v2ray && \
  rm v2ray.zip && \
  apt-get clean && rm -rf /var/lib/apt/lists/*

# Копируем проект
COPY bot.py .
COPY downloader.py .
COPY start.sh generate_config.py ./
RUN chmod +x start.sh

CMD ["./start.sh"]

