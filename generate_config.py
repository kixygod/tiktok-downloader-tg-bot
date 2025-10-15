#!/usr/bin/env python3
import json
import base64
import urllib.parse
import sys
import os


def parse_vless_url(url):
    """Парсит VLESS URL и возвращает параметры подключения"""
    if not url.startswith("vless://"):
        raise ValueError("Invalid VLESS URL format")

    # Убираем префикс vless://
    url_without_prefix = url[8:]

    # Разделяем на части: uuid@host:port?params#fragment
    if "@" not in url_without_prefix:
        raise ValueError("Invalid VLESS URL: missing @")

    uuid_part, rest = url_without_prefix.split("@", 1)

    # Извлекаем host:port
    if "?" in rest:
        host_port, params_part = rest.split("?", 1)
    else:
        host_port = rest
        params_part = ""

    if ":" in host_port:
        host, port = host_port.split(":", 1)
        port = int(port)
    else:
        host = host_port
        port = 443  # default port

    # Парсим параметры
    params = {}
    if params_part:
        for param in params_part.split("&"):
            if "=" in param:
                key, value = param.split("=", 1)
                params[key] = urllib.parse.unquote(value)

    return {"uuid": uuid_part, "host": host, "port": port, "params": params}


def create_v2ray_config(vless_data):
    """Создает конфигурацию v2ray на основе данных VLESS"""

    # Определяем сетевые настройки
    network = vless_data["params"].get("type", "tcp")
    security = vless_data["params"].get("security", "none")

    # Настройки для WebSocket
    ws_settings = {}
    if network == "ws":
        ws_settings = {"path": vless_data["params"].get("path", "/"), "headers": {}}
        if "host" in vless_data["params"]:
            ws_settings["headers"]["Host"] = vless_data["params"]["host"]

    # Настройки для TLS/Reality
    tls_settings = {}
    reality_settings = {}
    if security == "tls":
        tls_settings = {
            "serverName": vless_data["params"].get("sni", vless_data["host"])
        }
    elif security == "reality":
        reality_settings = {
            "serverName": vless_data["params"].get("sni", vless_data["host"]),
            "fingerprint": vless_data["params"].get("fp", "chrome"),
            "publicKey": vless_data["params"].get("pbk", ""),
            "shortId": vless_data["params"].get("sid", ""),
            "spiderX": vless_data["params"].get("spx", "/"),
        }

    config = {
        "log": {"loglevel": "warning"},
        "inbounds": [
            {
                "port": 1080,
                "protocol": "socks",
                "settings": {"auth": "noauth", "udp": True},
            },
            {"port": 8080, "protocol": "http", "settings": {"timeout": 0}},
        ],
        "outbounds": [
            {
                "protocol": "vless",
                "settings": {
                    "vnext": [
                        {
                            "address": vless_data["host"],
                            "port": vless_data["port"],
                            "users": [
                                {
                                    "id": vless_data["uuid"],
                                    "encryption": "none",
                                    "flow": (
                                        vless_data["params"].get("flow", "")
                                        if security == "reality"
                                        else None
                                    ),
                                }
                            ],
                        }
                    ]
                },
                "streamSettings": {
                    "network": network,
                    "security": security,
                    "xtlsSettings": (
                        {}
                        if security == "reality" and vless_data["params"].get("flow")
                        else None
                    ),
                },
            },
            {"protocol": "freedom", "settings": {}, "tag": "direct"},
        ],
        "routing": {
            "rules": [
                {"type": "field", "outboundTag": "direct", "domain": ["geosite:cn"]},
                {
                    "type": "field",
                    "outboundTag": "direct",
                    "ip": ["geoip:cn", "geoip:private"],
                },
            ]
        },
    }

    # Добавляем специфичные настройки для WebSocket
    if network == "ws":
        config["outbounds"][0]["streamSettings"]["wsSettings"] = ws_settings

    # Добавляем настройки TLS/Reality
    if security == "tls":
        config["outbounds"][0]["streamSettings"]["tlsSettings"] = tls_settings
    elif security == "reality":
        config["outbounds"][0]["streamSettings"]["realitySettings"] = reality_settings

    # Очищаем None значения из конфигурации
    def clean_none_values(obj):
        if isinstance(obj, dict):
            return {k: clean_none_values(v) for k, v in obj.items() if v is not None}
        elif isinstance(obj, list):
            return [clean_none_values(item) for item in obj if item is not None]
        else:
            return obj

    config = clean_none_values(config)
    return config


def main():
    if len(sys.argv) != 2:
        print("Usage: python3 generate_config.py <vless_url>")
        sys.exit(1)

    vless_url = sys.argv[1]

    try:
        # Парсим VLESS URL
        vless_data = parse_vless_url(vless_url)
        print(f"Parsed VLESS data: {vless_data}")

        # Создаем конфигурацию v2ray
        config = create_v2ray_config(vless_data)

        # Сохраняем конфигурацию
        with open("/app/v2ray-config.json", "w") as f:
            json.dump(config, f, indent=2)

        print("xray configuration generated successfully!")

    except Exception as e:
        print(f"Error: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
