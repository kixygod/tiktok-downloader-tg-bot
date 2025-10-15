FROM python:3.11-slim

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# WireGuard userspace tools
RUN apt-get update && apt-get install -y wireguard-tools iproute2 openresolv && rm -rf /var/lib/apt/lists/*

# Копируем проект
COPY bot.py .
COPY downloader.py .
COPY start.sh vpn.conf ./
RUN chown root:root /app/vpn.conf && chmod 600 /app/vpn.conf
RUN chmod +x start.sh

CMD ["./start.sh"]

