FROM python:3.11-slim

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Установка Xray (лучшая поддержка Reality)
RUN apt-get update && apt-get install -y curl unzip && \
  curl -L https://github.com/XTLS/Xray-core/releases/latest/download/Xray-linux-64.zip -o xray.zip && \
  unzip xray.zip -d /usr/bin/ && \
  chmod +x /usr/bin/xray && \
  rm xray.zip && \
  apt-get clean && rm -rf /var/lib/apt/lists/*

# Копируем проект
COPY bot.py .
COPY downloader.py .
COPY start.sh generate_config.py ./
RUN chmod +x start.sh

CMD ["./start.sh"]

