#!/usr/bin/env python3
"""
Модуль для мониторинга соединения с TikTok через VLESS прокси
"""
import asyncio
import logging
import subprocess
import time
import requests
from typing import Optional, Tuple

log = logging.getLogger("connection_monitor")


class ConnectionMonitor:
    def __init__(self, proxy_url: str = "http://127.0.0.1:8080"):
        self.proxy_url = proxy_url
        self.proxy_config = {"http": proxy_url, "https": proxy_url}
        self.is_connected = False
        self.last_check = 0
        self.check_interval = 3600  # 1 час
        self.failed_checks = 0
        self.max_failed_checks = 3

    async def check_tiktok_connectivity(self) -> Tuple[bool, str]:
        """Проверяет доступность TikTok через прокси"""
        try:
            # Проверяем доступность TikTok
            response = requests.get(
                "https://www.tiktok.com",
                proxies=self.proxy_config,
                timeout=10,
                headers={"User-Agent": "Mozilla/5.0"},
            )

            if response.status_code == 200:
                return True, "TikTok доступен через прокси"
            else:
                return False, f"TikTok недоступен: HTTP {response.status_code}"

        except requests.exceptions.ProxyError as e:
            return False, f"Ошибка прокси: {e}"
        except requests.exceptions.Timeout:
            return False, "Таймаут при подключении к TikTok"
        except requests.exceptions.ConnectionError as e:
            return False, f"Ошибка соединения: {e}"
        except Exception as e:
            return False, f"Неизвестная ошибка: {e}"

    async def ping_tiktok(self) -> Tuple[bool, str]:
        """Пингует TikTok сервер"""
        try:
            # Используем ping для проверки доступности
            result = subprocess.run(
                ["ping", "-c", "3", "www.tiktok.com"],
                capture_output=True,
                text=True,
                timeout=15,
            )

            if result.returncode == 0:
                return True, "Ping TikTok успешен"
            else:
                return False, f"Ping TikTok неудачен: {result.stderr}"

        except subprocess.TimeoutExpired:
            return False, "Ping TikTok: таймаут"
        except Exception as e:
            return False, f"Ping TikTok ошибка: {e}"

    async def check_proxy_status(self) -> Tuple[bool, str]:
        """Проверяет статус прокси сервера"""
        try:
            # Проверяем доступность прокси
            response = requests.get(
                "http://httpbin.org/ip", proxies=self.proxy_config, timeout=10
            )

            if response.status_code == 200:
                ip_info = response.json()
                return True, f"Прокси работает, IP: {ip_info.get('origin', 'unknown')}"
            else:
                return False, f"Прокси недоступен: HTTP {response.status_code}"

        except Exception as e:
            return False, f"Прокси недоступен: {e}"

    async def full_connectivity_check(self) -> Tuple[bool, str]:
        """Полная проверка соединения"""
        log.info("Выполняю полную проверку соединения...")

        # Проверяем прокси
        proxy_ok, proxy_msg = await self.check_proxy_status()
        if not proxy_ok:
            return False, f"Прокси недоступен: {proxy_msg}"

        # Проверяем TikTok
        tiktok_ok, tiktok_msg = await self.check_tiktok_connectivity()
        if not tiktok_ok:
            return False, f"TikTok недоступен: {tiktok_msg}"

        # Пингуем TikTok
        ping_ok, ping_msg = await self.ping_tiktok()
        if not ping_ok:
            log.warning(f"Ping TikTok неудачен: {ping_msg}")

        return True, f"Соединение OK. {proxy_msg}, {tiktok_msg}"

    async def start_monitoring(self):
        """Запускает мониторинг соединения"""
        log.info("Запускаю мониторинг соединения...")

        while True:
            try:
                current_time = time.time()

                # Проверяем соединение каждые check_interval секунд
                if current_time - self.last_check >= self.check_interval:
                    log.info("Выполняю плановую проверку соединения...")

                    is_connected, message = await self.full_connectivity_check()

                    if is_connected:
                        self.is_connected = True
                        self.failed_checks = 0
                        log.info(f"✅ {message}")
                    else:
                        self.failed_checks += 1
                        log.error(f"❌ {message}")

                        if self.failed_checks >= self.max_failed_checks:
                            log.error(
                                f"Критическая ошибка: {self.failed_checks} неудачных проверок подряд!"
                            )
                            # Здесь можно добавить уведомления или перезапуск

                    self.last_check = current_time

                # Ждем 60 секунд перед следующей проверкой
                await asyncio.sleep(60)

            except Exception as e:
                log.error(f"Ошибка в мониторинге: {e}")
                await asyncio.sleep(60)

    def get_status(self) -> dict:
        """Возвращает текущий статус соединения"""
        return {
            "is_connected": self.is_connected,
            "last_check": self.last_check,
            "failed_checks": self.failed_checks,
            "proxy_url": self.proxy_url,
        }


# Глобальный экземпляр монитора
monitor = ConnectionMonitor()


async def start_connection_monitor():
    """Запускает мониторинг соединения в фоновом режиме"""
    # Запускаем мониторинг в фоновом режиме
    task = asyncio.create_task(monitor.start_monitoring())
    log.info("Connection monitor started in background")
    return task


def get_connection_status() -> dict:
    """Возвращает статус соединения"""
    return monitor.get_status()
