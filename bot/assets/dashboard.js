const PAGE_SIZE = 30;
let page = 0,
  totalRows = 0;
let chartsInited = false;
let chartMissingLogged = false;
let dailyC, hourlyC, perfC, platformC, statusC, trafficC;

let loadStatsBusy = false;
let loadStatsPending = false;
let loadQueueBusy = false;
let loadQueuePending = false;
let loadChartsBusy = false;
let loadChartsPending = false;
let loadRecentBusy = false;
let loadRecentPending = false;
let modalFocusTrapCleanup = null;
let focusBeforeModal = null;
let eventSource = null;
let refreshTimer = null;
const pendingScopes = new Set();

function docHidden() {
  return document.visibilityState === "hidden";
}

function cssToken(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

const chartPalette = {
  brand: cssToken("--brand"),
  success: cssToken("--success"),
  danger: cssToken("--danger"),
  warning: cssToken("--warning"),
  info: cssToken("--info"),
  cache: cssToken("--cache"),
  muted: cssToken("--muted"),
  line: cssToken("--line"),
  surface: cssToken("--surface"),
  text: cssToken("--text"),
};
const dashboardFont = getComputedStyle(document.body).fontFamily;
if (typeof Chart !== "undefined") Chart.defaults.font.family = dashboardFont;

function chartAlpha(color, alpha) {
  const hex = color.replace("#", "");
  const normalized = hex.length === 3 ? [...hex].map((part) => part + part).join("") : hex;
  if (!/^[\da-f]{6}$/i.test(normalized)) return color;
  const red = parseInt(normalized.slice(0, 2), 16);
  const green = parseInt(normalized.slice(2, 4), 16);
  const blue = parseInt(normalized.slice(4, 6), 16);
  return `rgba(${red},${green},${blue},${alpha})`;
}

const chartDefaults = {
  responsive: true,
  maintainAspectRatio: false,
  plugins: {
    legend: { display: false },
    tooltip: {
      backgroundColor: chartPalette.text,
      titleColor: chartPalette.surface,
      bodyColor: chartPalette.surface,
      borderColor: chartPalette.line,
      borderWidth: 1,
      padding: 10,
      cornerRadius: 10,
    },
  },
  scales: {
    x: {
      grid: { color: chartPalette.line },
      ticks: { color: chartPalette.muted, font: { size: 11 } },
    },
    y: {
      grid: { color: chartPalette.line },
      ticks: { color: chartPalette.muted, font: { size: 11 } },
      beginAtZero: true,
    },
  },
};

function escapeHtml(s) {
  if (s == null || s === "") return "";
  const div = document.createElement("div");
  div.textContent = String(s);
  return div.innerHTML;
}

function setDashBanner(message) {
  const el = document.getElementById("dash-banner");
  if (!el) return;
  if (!message) {
    el.classList.add("dash-banner--hidden");
    el.textContent = "";
    return;
  }
  el.textContent = message;
  el.classList.remove("dash-banner--hidden");
}

function showToast(text, variant) {
  let root = document.getElementById("toast-root");
  if (!root) {
    root = document.createElement("div");
    root.id = "toast-root";
    root.className = "toast-root";
    document.body.appendChild(root);
  }
  const t = document.createElement("div");
  t.className = "toast" + (variant === "error" ? " toast--err" : " toast--ok");
  t.textContent = text;
  root.appendChild(t);
  setTimeout(() => {
    t.classList.add("toast--out");
    setTimeout(() => t.remove(), 280);
  }, 4200);
}

function removeModalFocusTrap() {
  const overlay = document.getElementById("cache-modal-overlay");
  if (modalFocusTrapCleanup && overlay) {
    overlay.removeEventListener("keydown", modalFocusTrapCleanup);
    modalFocusTrapCleanup = null;
  }
}

function installModalFocusTrap() {
  removeModalFocusTrap();
  const overlay = document.getElementById("cache-modal-overlay");
  if (!overlay) return;
  modalFocusTrapCleanup = (e) => {
    if (e.key !== "Tab") return;
    const modal = overlay.querySelector(".cache-modal");
    if (!modal) return;
    const raw = modal.querySelectorAll(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );
    const focusables = [...raw].filter(
      (el) => el.offsetParent !== null || el === document.activeElement,
    );
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey) {
      if (document.activeElement === first) {
        e.preventDefault();
        last.focus();
      }
    } else if (document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };
  overlay.addEventListener("keydown", modalFocusTrapCleanup);
}

function focusModalClose() {
  document.getElementById("cache-modal-close")?.focus();
}

function fmtBytes(b) {
  if (!b) return "0";
  b = Number(b);
  if (b < 1024) return b + "B";
  if (b < 1048576) return (b / 1024).toFixed(1) + "KB";
  return (b / 1048576).toFixed(1) + "MB";
}
function fmtMs(ms) {
  ms = Number(ms);
  if (ms < 1000) return ms + "ms";
  if (ms < 60000) return (ms / 1000).toFixed(1) + "s";
  return Math.floor(ms / 60000) + "m" + Math.round((ms % 60000) / 1000) + "s";
}
function fmtTime(ts) {
  const d = new Date(Number(ts));
  return d.toLocaleString("ru", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}
function statusBadge(s) {
  const m = {
    success: ["Успех", "badge-ok"],
    cached: ["Кэш", "badge-cache"],
    compressed: ["Сжат", "badge-comp"],
    too_large: ["Большой", "badge-large"],
    failed: ["Ошибка", "badge-fail"],
  };
  if (m[s]) {
    const [l, c] = m[s];
    return `<span class="badge ${c}">${l}</span>`;
  }
  return `<span class="badge">${escapeHtml(String(s ?? ""))}</span>`;
}
function platformLabel(p) {
  return (
    {
      tiktok: "TikTok",
      youtube: "YouTube",
      vk: "VK",
      instagram: "Instagram",
      twitter: "X / Twitter",
      bluesky: "Bluesky",
      reddit: "Reddit",
      pinterest: "Pinterest",
      flickr: "Flickr",
      tumblr: "Tumblr",
      facebook: "Facebook",
    }[p] ||
    p ||
    "Неизвестная"
  );
}

function chatTypeLabel(t) {
  const k = {
    private: "Личка",
    group: "Группа",
    supergroup: "Группа",
    channel: "Канал",
  };
  if (k[t]) return k[t];
  return t ? escapeHtml(String(t)) : "";
}

/** Буква для заглушки аватара (имя / username). */
function userAvatarInitial(name) {
  const s = String(name ?? "").trim();
  if (!s) return "?";
  const cp = s.codePointAt(0);
  if (cp === undefined) return "?";
  return String.fromCodePoint(cp).toLocaleUpperCase("ru");
}

async function loadQueue() {
  if (docHidden()) return;
  if (loadQueueBusy) {
    loadQueuePending = true;
    return;
  }
  loadQueueBusy = true;
  try {
    const r = await fetch("/api/queue", { credentials: "include" });
    const d = await r.json();
    if (!r.ok) {
      showToast("Очередь: ошибка ответа сервера", "error");
      return;
    }
    document.getElementById("q-waiting").textContent = d.waiting;
    document.getElementById("q-active").textContent = d.active;
    document.getElementById("q-delayed").textContent = d.delayed;
    document.getElementById("queueStatus").textContent = d.failed
      ? `Ошибок в очереди: ${d.failed}`
      : "Очередь без ошибок";
    document.getElementById("lastUpdate").textContent =
      "Обновлено " + new Date().toLocaleTimeString("ru");
  } catch (e) {
    console.error(e);
    showToast("Очередь: нет сети", "error");
  } finally {
    loadQueueBusy = false;
    if (loadQueuePending) {
      loadQueuePending = false;
      loadQueue();
    }
  }
}
async function loadStats() {
  if (docHidden()) return;
  if (loadStatsBusy) {
    loadStatsPending = true;
    return;
  }
  loadStatsBusy = true;
  try {
    const r = await fetch("/api/stats", { credentials: "include" });
    const d = await r.json();
    if (!r.ok) {
      setDashBanner(
        "Статистика не загрузилась. Проверьте доступ к панели.",
      );
      document.getElementById("kpi-row")?.classList.remove("kpi-row--loading");
      return;
    }
    setDashBanner("");
    document.getElementById("kpi-row")?.classList.remove("kpi-row--loading");
    document.getElementById("k-daily").textContent = d.daily;
    document.getElementById("k-weekly").textContent = d.weekly;
    document.getElementById("k-monthly").textContent = d.monthly;
    document.getElementById("k-total").textContent = d.total;
    document.getElementById("k-success").textContent = d.totalSuccess;
    document.getElementById("k-cached").textContent = d.totalCached ?? 0;
    document.getElementById("k-failed").textContent = d.totalFailed;
    document.getElementById("k-traffic").textContent =
      d.traffic >= 1024
        ? (d.traffic / 1024).toFixed(1) + " GB"
        : d.traffic + " MB";
    document.getElementById("k-avgtime").textContent = fmtMs(d.avgDuration);
    document.getElementById("lastUpdate").textContent =
      "Обновлено " + new Date().toLocaleTimeString("ru");
    if (d.trafficByPlatform && d.trafficByPlatform.length) {
      document.getElementById("trafficByPlatform").innerHTML =
        d.trafficByPlatform
          .map(
            (p) =>
              `<div class="row"><span>${escapeHtml(platformLabel(p.platform))}</span><span>${escapeHtml(String(p.mb))} MB</span></div>`,
          )
          .join("");
    } else {
      document.getElementById("trafficByPlatform").innerHTML =
        "<div class='row'><span>Нет данных</span></div>";
    }
    if (d.avgByPlatform && d.avgByPlatform.length) {
      document.getElementById("avgByPlatform").innerHTML = d.avgByPlatform
        .map(
          (p) =>
            `<div class="row"><span>${escapeHtml(platformLabel(p.platform))}</span><span>${escapeHtml(fmtMs(p.avgMs))}</span></div>`,
        )
        .join("");
    } else {
      document.getElementById("avgByPlatform").innerHTML =
        "<div class='row'><span>Нет данных</span></div>";
    }
    if (d.topUsers && d.topUsers.length) {
      document.getElementById("topUsers").innerHTML = d.topUsers
        .map((u, i) => {
          const link = u.profileUrl
            ? `<a href="${escapeHtml(u.profileUrl)}" target="_blank" rel="noopener">${escapeHtml(u.name)}</a>`
            : escapeHtml(u.name);
          const avInit = escapeHtml(userAvatarInitial(u.name));
          const avatar = `<img class="user-avatar" src="${escapeHtml(u.avatarUrl)}" alt="" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.classList.add('user-avatar-placeholder--visible');" /><span class="user-avatar-placeholder" aria-hidden="true">${avInit}</span>`;
          return `<div class="row user-row"><span><span class="user-cell">${avatar}${link}</span></span><span>${u.count} (${fmtBytes(u.bytes)})</span></div>`;
        })
        .join("");
    } else {
      document.getElementById("topUsers").innerHTML =
        "<div class='row'><span>Нет данных</span></div>";
    }
  } catch (e) {
    console.error(e);
    setDashBanner("Статистика: ошибка сети.");
    document.getElementById("kpi-row")?.classList.remove("kpi-row--loading");
  } finally {
    loadStatsBusy = false;
    if (loadStatsPending) {
      loadStatsPending = false;
      loadStats();
    }
  }
}

async function loadCharts() {
  if (docHidden()) return;
  if (loadChartsBusy) {
    loadChartsPending = true;
    return;
  }
  if (typeof Chart === "undefined") {
    if (!chartMissingLogged) {
      chartMissingLogged = true;
      console.warn(
        "Chart.js не загружен (откройте /vendor/chart.umd.js или см. логи контейнера bot).",
      );
    }
    return;
  }
  loadChartsBusy = true;
  try {
    const r = await fetch("/api/charts", { credentials: "include" });
    const d = await r.json();
    if (!r.ok) {
      showToast("Графики: нет данных с сервера", "error");
      return;
    }
    const daily = Array.isArray(d.daily) ? d.daily : [];
    const hourly = Array.isArray(d.hourly) ? d.hourly : [];
    const platforms = Array.isArray(d.platforms) ? d.platforms : [];
    const statuses = Array.isArray(d.statuses) ? d.statuses : [];
    renderDailyChart(daily);
    renderHourlyChart(hourly);
    renderPerfChart(daily);
    renderTrafficChart(daily);
    renderPlatformChart(platforms);
    renderStatusChart(statuses);
  } catch (e) {
    console.error(e);
    showToast("Графики: ошибка сети", "error");
  } finally {
    loadChartsBusy = false;
    if (loadChartsPending) {
      loadChartsPending = false;
      loadCharts();
    }
  }
}
function renderTrafficChart(data) {
  if (!Array.isArray(data)) data = [];
  const labels = data.map((d) => {
    const p = d.date.split("-");
    return p[2] + "." + p[1];
  });
  const mbData = data.map(
    (d) => Math.round((Number(d.total_bytes || 0) / 1024 / 1024) * 10) / 10,
  );
  const cfg = {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          label: "Трафик (MB)",
          data: mbData,
          backgroundColor: chartAlpha(chartPalette.info, 0.68),
          borderRadius: 6,
        },
      ],
    },
    options: chartDefaults,
  };
  if (trafficC) {
    trafficC.data = cfg.data;
    trafficC.update("none");
  } else {
    trafficC = new Chart(document.getElementById("trafficChart"), cfg);
  }
}

function renderDailyChart(data) {
  if (!Array.isArray(data)) data = [];
  const labels = data.map((d) => {
    const p = d.date.split("-");
    return p[2] + "." + p[1];
  });
  const cfg = {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          label: "Успех",
          data: data.map((d) => d.success || 0),
          backgroundColor: chartAlpha(chartPalette.success, 0.74),
          borderRadius: 5,
        },
        {
          label: "Ошибки",
          data: data.map((d) => d.failed || 0),
          backgroundColor: chartAlpha(chartPalette.danger, 0.68),
          borderRadius: 5,
        },
      ],
    },
    options: {
      ...chartDefaults,
      plugins: {
        ...chartDefaults.plugins,
        legend: {
          display: true,
          labels: { color: chartPalette.muted, font: { size: 11 } },
        },
      },
      scales: {
        ...chartDefaults.scales,
        x: { ...chartDefaults.scales.x, stacked: true },
        y: { ...chartDefaults.scales.y, stacked: true },
      },
    },
  };
  if (dailyC) {
    dailyC.data = cfg.data;
    dailyC.update("none");
  } else {
    dailyC = new Chart(document.getElementById("dailyChart"), cfg);
  }
}

function renderHourlyChart(data) {
  if (!Array.isArray(data)) data = [];
  const full = Array.from({ length: 24 }, (_, i) => ({
    hour: i,
    count: 0,
    success: 0,
    failed: 0,
  }));
  data.forEach((d) => {
    const h = Number(d.hour);
    full[h] = {
      hour: h,
      count: Number(d.count),
      success: Number(d.success || 0),
      failed: Number(d.failed || 0),
    };
  });
  const cfg = {
    type: "line",
    data: {
      labels: full.map((d) => d.hour + ":00"),
      datasets: [
        {
          label: "Запросы",
          data: full.map((d) => d.count),
          borderColor: chartPalette.brand,
          backgroundColor: chartAlpha(chartPalette.brand, 0.12),
          fill: true,
          tension: 0.3,
          pointRadius: 3,
          pointBackgroundColor: chartPalette.brand,
        },
      ],
    },
    options: chartDefaults,
  };
  if (hourlyC) {
    hourlyC.data = cfg.data;
    hourlyC.update("none");
  } else {
    hourlyC = new Chart(document.getElementById("hourlyChart"), cfg);
  }
}

function renderPerfChart(data) {
  if (!Array.isArray(data)) data = [];
  const labels = data.map((d) => {
    const p = d.date.split("-");
    return p[2] + "." + p[1];
  });
  const cfg = {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "Ср. время (ms)",
          data: data.map((d) => Math.round(d.avg_duration || 0)),
          borderColor: chartPalette.warning,
          backgroundColor: chartAlpha(chartPalette.warning, 0.12),
          fill: true,
          tension: 0.3,
          pointRadius: 3,
          pointBackgroundColor: chartPalette.warning,
        },
      ],
    },
    options: chartDefaults,
  };
  if (perfC) {
    perfC.data = cfg.data;
    perfC.update("none");
  } else {
    perfC = new Chart(document.getElementById("perfChart"), cfg);
  }
}

function renderPlatformChart(data) {
  if (!data || !data.length) {
    if (platformC) {
      platformC.destroy();
      platformC = null;
    }
    return;
  }
  const colors = [
    chartPalette.brand,
    chartPalette.info,
    chartPalette.success,
    chartPalette.warning,
    chartPalette.cache,
    chartPalette.danger,
  ];
  const cfg = {
    type: "doughnut",
    data: {
      labels: data.map((d) => String(platformLabel(d.platform))),
      datasets: [
        {
          data: data.map((d) => Number(d.count)),
          backgroundColor: colors.slice(0, data.length),
          borderColor: chartPalette.surface,
          borderWidth: 3,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          position: "bottom",
          labels: { color: chartPalette.muted, font: { size: 11 }, padding: 14 },
        },
      },
    },
  };
  if (platformC) {
    platformC.data = cfg.data;
    platformC.update("none");
  } else {
    platformC = new Chart(document.getElementById("platformChart"), cfg);
  }
}

function renderStatusChart(data) {
  if (!data || !data.length) {
    if (statusC) {
      statusC.destroy();
      statusC = null;
    }
    return;
  }
  const cmap = {
    success: chartPalette.success,
    cached: chartPalette.cache,
    compressed: chartPalette.warning,
    too_large: chartPalette.info,
    failed: chartPalette.danger,
  };
  const nmap = {
    success: "Успех",
    cached: "Кэш",
    compressed: "Сжат",
    too_large: "Большой",
    failed: "Ошибка",
  };
  const cfg = {
    type: "doughnut",
    data: {
      labels: data.map((d) => String(nmap[d.status] ?? d.status ?? "")),
      datasets: [
        {
          data: data.map((d) => Number(d.count)),
          backgroundColor: data.map((d) => cmap[d.status] || chartPalette.muted),
          borderColor: chartPalette.surface,
          borderWidth: 3,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          position: "bottom",
          labels: { color: chartPalette.muted, font: { size: 11 }, padding: 14 },
        },
      },
    },
  };
  if (statusC) {
    statusC.data = cfg.data;
    statusC.update("none");
  } else {
    statusC = new Chart(document.getElementById("statusChart"), cfg);
  }
}

async function loadRecent() {
  if (docHidden()) return;
  if (loadRecentBusy) {
    loadRecentPending = true;
    return;
  }
  loadRecentBusy = true;
  const status = document.getElementById("f-status").value;
  const platform = document.getElementById("f-platform").value;
  const search = document.getElementById("f-search").value.trim();
  const params = new URLSearchParams({
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
  });
  if (status) params.set("status", status);
  if (platform) params.set("platform", platform);
  if (search) params.set("q", search);

  try {
    const r = await fetch("/api/admin/recent?" + params, {
      credentials: "include",
    });
    const d = await r.json();
    if (!r.ok) {
      showToast("Таблица: ошибка ответа", "error");
      return;
    }
    totalRows = d.total ?? 0;
    const tbody = document.getElementById("tbody");
    const items = Array.isArray(d.items) ? d.items : [];
    tbody.innerHTML = items.length
      ? items
      .map((j) => {
        const url = j.url || "";
        const safeUrl = /^https?:\/\//i.test(url);
        const urlDisplay = safeUrl
          ? `<a class="request-link" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(url)}">${escapeHtml(url)}</a>`
          : `<span class="request-link">${escapeHtml(url) || "Ссылка не указана"}</span>`;
        const fullError = j.error_message ? escapeHtml(String(j.error_message)) : "";
        const err = j.error_message ? escapeHtml(String(j.error_message).slice(0, 88)) : "";
        const requestId = escapeHtml(String(j.id ?? "-"));
        const requestTime = escapeHtml(fmtTime(j.ts));
        const userName =
          j.first_name ||
          j.username ||
          (j.user_id ? "id" + j.user_id : "") ||
          j.chat_id ||
          "-";
        const userLink = j.userProfileUrl
          ? `<a href="${escapeHtml(j.userProfileUrl)}" target="_blank" rel="noopener" class="user-name">${escapeHtml(userName)}</a>`
          : `<span class="user-name">${escapeHtml(userName)}</span>`;
        const avInit = escapeHtml(userAvatarInitial(userName));
        const avatarHtml = j.user_id
          ? `<img class="user-avatar" src="/api/avatar/${j.user_id}" alt="" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.classList.add('user-avatar-placeholder--visible');" /><span class="user-avatar-placeholder" aria-hidden="true">${avInit}</span>`
          : `<span class="user-avatar-placeholder user-avatar-placeholder--visible user-avatar-placeholder--empty">${avInit}</span>`;
        const chatTitle =
          j.chatTitle || (j.chat_id ? "Чат " + j.chat_id : "-");
        const chatLink = j.chatUrl
          ? `<a href="${escapeHtml(j.chatUrl)}" target="_blank" rel="noopener">${escapeHtml(chatTitle)}</a>`
          : escapeHtml(chatTitle);
        const chatBadge = j.chatType
          ? `<span class="chat-type-badge">${chatTypeLabel(j.chatType)}</span>`
          : "";
        const cp = j.cachePreview || {};
        let cacheCell;
        if (cp.available && cp.kind) {
          const lbl =
            cp.kind === "video"
              ? "Видео"
              : cp.imageCount === 1
                ? "1 фото"
                : `${cp.imageCount} фото`;
          const mediaLabel = cp.kind === "video" ? "Открыть видео из кэша" : "Открыть фото из кэша";
          cacheCell = `<button type="button" class="btn-cache-view" data-job-id="${escapeHtml(String(j.id))}" data-kind="${escapeHtml(cp.kind)}" data-image-count="${Number(cp.imageCount) || 0}" aria-label="${mediaLabel}, запрос ${requestId}">${escapeHtml(lbl)}</button>`;
        } else {
          cacheCell = `<span class="cache-miss-wrap"><span class="cache-miss" title="Медиа больше нет в кэше">Нет в кэше</span><button type="button" class="btn-cache-rehydrate" title="Проверить кэш на диске" data-job-id="${escapeHtml(String(j.id))}" aria-label="Проверить кэш, запрос ${requestId}"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M16 10a6 6 0 1 1-1.5-4M16 4v4h-4" /></svg></button></span>`;
        }
        return `<tr>
<td data-label="Запрос"><div class="request-cell"><span class="request-id">#${requestId}</span>${urlDisplay}<span class="request-meta">${requestTime}</span></div></td>
<td data-label="Пользователь и чат"><div class="person-cell">${avatarHtml}<div class="person-content"><div class="user-cell">${userLink}</div><div class="person-chat">${chatBadge}${chatLink}</div></div></div></td>
<td data-label="Источник"><span class="platform-chip">${escapeHtml(platformLabel(j.platform))}</span></td>
<td data-label="Результат"><div class="status-cell">${statusBadge(j.status)}${err ? `<span class="error-cell" title="${fullError}">${err}</span>` : ""}</div></td>
<td data-label="Медиа" class="cache-cell">${cacheCell}</td>
<td data-label="Размер и время"><div class="transfer-cell"><strong>${fmtBytes(j.bytes)}</strong><span class="transfer-meta">Обработка ${fmtMs(j.duration_ms)}</span></div></td>
    </tr>`;
      })
      .join("")
      : '<tr><td colspan="6" class="empty-table">По этим фильтрам запросов нет</td></tr>';

    const pages = Math.ceil(totalRows / PAGE_SIZE);
    document.getElementById("pg-info").textContent = `${page + 1} / ${
      pages || 1
    } (${totalRows})`;
    document.getElementById("pg-prev").disabled = page <= 0;
    document.getElementById("pg-next").disabled = page >= pages - 1;
  } catch (e) {
    console.error(e);
    showToast("Таблица: сеть", "error");
  } finally {
    loadRecentBusy = false;
    if (loadRecentPending) {
      loadRecentPending = false;
      loadRecent();
    }
  }
}

document.getElementById("pg-prev").onclick = () => {
  if (page > 0) {
    page--;
    loadRecent();
  }
};
document.getElementById("pg-next").onclick = () => {
  page++;
  loadRecent();
};
document.getElementById("f-status").onchange = () => {
  page = 0;
  loadRecent();
};
document.getElementById("f-platform").onchange = () => {
  page = 0;
  loadRecent();
};
let searchTimer;
document.getElementById("f-search").oninput = () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    page = 0;
    loadRecent();
  }, 400);
};

let modalNavigate = null;

function closeCacheModal() {
  removeModalFocusTrap();
  const ov = document.getElementById("cache-modal-overlay");
  ov.classList.remove("open");
  ov.setAttribute("aria-hidden", "true");
  const body = document.getElementById("cache-modal-body");
  const v = body.querySelector("video");
  if (v) {
    v.pause();
    v.removeAttribute("src");
    v.load();
  }
  body.innerHTML = '<span class="cache-modal-loading">Откройте медиа из журнала</span>';
  document.body.classList.remove("modal-open");
  modalNavigate = null;
  if (focusBeforeModal && typeof focusBeforeModal.focus === "function") {
    try {
      focusBeforeModal.focus();
    } catch (_) {}
  }
  focusBeforeModal = null;
}

function openCacheModal(jobId, kind, imageCount) {
  focusBeforeModal = document.activeElement;
  const overlay = document.getElementById("cache-modal-overlay");
  const body = document.getElementById("cache-modal-body");
  overlay.classList.add("open");
  overlay.setAttribute("aria-hidden", "false");
  document.body.classList.add("modal-open");
  document.getElementById("cache-modal-title").textContent =
    kind === "video" ? "Просмотр видео" : "Галерея изображений";
  document.getElementById("cache-modal-meta").textContent =
    kind === "video"
      ? `Запрос ${jobId} · видео из кэша`
      : `${Math.max(1, Number(imageCount) || 1)} изображений · запрос ${jobId}`;
  body.innerHTML = '<span class="cache-modal-loading">Открываем медиа</span>';
  installModalFocusTrap();
  requestAnimationFrame(() => focusModalClose());

  const count = Math.max(1, Number(imageCount) || 1);
  let current = 0;
  const viewer = document.createElement("div");
  viewer.className = `media-viewer media-viewer--${kind === "video" ? "video" : "images"}`;
  const stage = document.createElement("div");
  stage.className = "media-stage";
  stage.tabIndex = 0;
  stage.setAttribute("aria-label", kind === "video" ? "Видеоплеер" : "Просмотр изображения");
  const toolbar = document.createElement("div");
  toolbar.className = "media-toolbar";
  const controls = document.createElement("div");
  controls.className = "media-toolbar-group";
  const actions = document.createElement("div");
  actions.className = "media-toolbar-group";
  let thumbnailStrip = null;
  const download = document.createElement("a");
  download.className = "button media-download";
  download.textContent = kind === "video" ? "Скачать видео" : "Скачать изображение";
  download.setAttribute("download", "");
  const fullscreen = document.createElement("button");
  fullscreen.type = "button";
  fullscreen.className = "button button-quiet";
  fullscreen.textContent = "На весь экран";
  fullscreen.addEventListener("click", () => {
    if (document.fullscreenElement) {
      document.exitFullscreen?.();
    } else {
      stage.requestFullscreen?.();
    }
  });
  actions.append(download, fullscreen);

  if (kind === "video") {
    const videoUrl = `/api/admin/cache/${encodeURIComponent(jobId)}/video`;
    const video = document.createElement("video");
    video.controls = false;
    video.playsInline = true;
    video.preload = "metadata";
    video.tabIndex = 0;
    video.src = videoUrl;
    video.setAttribute("aria-label", "Видео из кэша");

    const videoControls = document.createElement("div");
    videoControls.className = "media-video-controls";
    videoControls.setAttribute("aria-label", "Управление видео");
    videoControls.addEventListener("click", (event) => event.stopPropagation());

    const playButton = document.createElement("button");
    playButton.type = "button";
    playButton.className = "media-control-button media-play-toggle";
    playButton.setAttribute("aria-label", "Воспроизвести");

    const seek = document.createElement("input");
    seek.className = "media-seek";
    seek.type = "range";
    seek.min = "0";
    seek.max = "1000";
    seek.value = "0";
    seek.setAttribute("aria-label", "Позиция воспроизведения");

    const timeLabel = document.createElement("span");
    timeLabel.className = "media-time";
    timeLabel.setAttribute("aria-live", "off");

    const muteButton = document.createElement("button");
    muteButton.type = "button";
    muteButton.className = "media-control-button media-mute-toggle";
    muteButton.textContent = "Звук";

    const volume = document.createElement("input");
    volume.className = "media-volume";
    volume.type = "range";
    volume.min = "0";
    volume.max = "1";
    volume.step = "0.05";
    volume.value = "0.8";
    volume.setAttribute("aria-label", "Громкость");

    const formatVideoTime = (seconds) => {
      if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
      const total = Math.floor(seconds);
      return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
    };
    const updateVideoControls = () => {
      const duration = Number.isFinite(video.duration) ? video.duration : 0;
      const position = Number.isFinite(video.currentTime) ? video.currentTime : 0;
      seek.value = String(duration ? Math.round((position / duration) * 1000) : 0);
      seek.setAttribute("aria-valuetext", `${formatVideoTime(position)} из ${formatVideoTime(duration)}`);
      timeLabel.textContent = `${formatVideoTime(position)} / ${formatVideoTime(duration)}`;
      playButton.innerHTML = video.paused
        ? '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2.5v11L13 8z" /></svg>'
        : '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 3h3v10H4zm5 0h3v10H9z" /></svg>';
      playButton.setAttribute("aria-label", video.paused ? "Воспроизвести" : "Пауза");
      muteButton.setAttribute("aria-pressed", String(video.muted));
      muteButton.setAttribute("aria-label", video.muted ? "Включить звук" : "Выключить звук");
    };

    playButton.addEventListener("click", () => {
      if (video.paused) video.play().catch(() => {});
      else video.pause();
    });
    seek.addEventListener("input", () => {
      if (Number.isFinite(video.duration) && video.duration > 0) {
        video.currentTime = (Number(seek.value) / 1000) * video.duration;
      }
    });
    muteButton.addEventListener("click", () => {
      video.muted = !video.muted;
      updateVideoControls();
    });
    volume.addEventListener("input", () => {
      video.volume = Number(volume.value);
      video.muted = video.volume === 0;
      updateVideoControls();
    });
    ["play", "pause", "ended", "timeupdate", "loadedmetadata", "durationchange", "volumechange"].forEach((eventName) => {
      video.addEventListener(eventName, updateVideoControls);
    });
    video.volume = Number(volume.value);
    updateVideoControls();
    videoControls.append(playButton, seek, timeLabel, muteButton, volume);

    video.addEventListener("error", () => {
      const message = document.createElement("p");
      message.className = "media-stage-error";
      message.textContent = "Не удалось открыть видео из кэша.";
      stage.replaceChildren(message);
    });
    download.href = videoUrl;
    download.download = `media-${jobId}.mp4`;
    stage.append(video, videoControls);
  } else {
    const image = document.createElement("img");
    image.alt = "";
    image.decoding = "async";
    image.addEventListener("click", () => {
      const zoomed = image.classList.toggle("is-zoomed");
      stage.classList.toggle("is-zoomed", zoomed);
      zoomButton.setAttribute("aria-pressed", String(zoomed));
      zoomButton.textContent = zoomed ? "Уменьшить" : "Увеличить";
    });
    image.addEventListener("error", () => {
      const message = document.createElement("p");
      message.className = "media-stage-error";
      message.textContent = "Не удалось загрузить это изображение из кэша.";
      stage.replaceChildren(message);
    });

    const counter = document.createElement("span");
    counter.className = "media-counter";
    counter.setAttribute("aria-live", "polite");
    const previous = document.createElement("button");
    previous.type = "button";
    previous.className = "button button-quiet";
    previous.textContent = "Назад";
    previous.setAttribute("aria-label", "Предыдущее изображение");
    const next = document.createElement("button");
    next.type = "button";
    next.className = "button button-quiet";
    next.textContent = "Вперёд";
    next.setAttribute("aria-label", "Следующее изображение");
    const zoomButton = document.createElement("button");
    zoomButton.type = "button";
    zoomButton.className = "button button-quiet";
    zoomButton.textContent = "Увеличить";
    zoomButton.setAttribute("aria-pressed", "false");
    zoomButton.addEventListener("click", () => image.click());
    previous.addEventListener("click", () => showIndex(current - 1));
    next.addEventListener("click", () => showIndex(current + 1));
    controls.append(previous, counter, next, zoomButton);

    const thumbnails = document.createElement("div");
    thumbnails.className = "media-thumbnails";
    thumbnails.setAttribute("aria-label", "Миниатюры изображений");
    thumbnailStrip = thumbnails;
    const thumbnailButtons = [];
    for (let index = 0; index < count; index++) {
      const thumbnail = document.createElement("button");
      thumbnail.type = "button";
      thumbnail.className = "media-thumbnail";
      thumbnail.setAttribute("aria-label", `Показать изображение ${index + 1}`);
      thumbnail.setAttribute("aria-current", index === 0 ? "true" : "false");
      const thumbImage = document.createElement("img");
      thumbImage.alt = "";
      thumbImage.loading = "lazy";
      thumbImage.src = `/api/admin/cache/${encodeURIComponent(jobId)}/image/${index}`;
      thumbnail.appendChild(thumbImage);
      thumbnail.addEventListener("click", () => showIndex(index));
      thumbnails.appendChild(thumbnail);
      thumbnailButtons.push(thumbnail);
    }

    function showIndex(index) {
      if (index < 0 || index >= count) return;
      current = index;
      if (!image.isConnected) stage.replaceChildren(image);
      const imageUrl = `/api/admin/cache/${encodeURIComponent(jobId)}/image/${index}`;
      image.classList.remove("is-zoomed");
      stage.classList.remove("is-zoomed");
      zoomButton.setAttribute("aria-pressed", "false");
      zoomButton.textContent = "Увеличить";
      image.alt = `Изображение ${index + 1} из ${count}`;
      image.src = imageUrl;
      counter.textContent = `${index + 1} из ${count}`;
      download.href = imageUrl;
      download.download = `media-${jobId}-${index + 1}.jpg`;
      previous.disabled = index === 0;
      next.disabled = index === count - 1;
      thumbnailButtons.forEach((button, thumbIndex) => {
        button.setAttribute("aria-current", String(thumbIndex === index));
        if (thumbIndex === index) button.scrollIntoView({ block: "nearest", inline: "nearest" });
      });
    }

    modalNavigate = (direction) => showIndex(current + direction);
    stage.appendChild(image);
    showIndex(0);
  }

  toolbar.append(controls, actions);
  if (thumbnailStrip) viewer.append(stage, thumbnailStrip, toolbar);
  else viewer.append(stage, toolbar);
  body.replaceChildren(viewer);
  requestAnimationFrame(() => focusModalClose());
}

function setLiveStatus(state, label) {
  const status = document.getElementById("liveStatus");
  status.dataset.state = state;
  document.getElementById("liveStatusLabel").textContent = label;
}

function scheduleDashboardRefresh(scopes) {
  scopes.forEach((scope) => pendingScopes.add(scope));
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    const nextScopes = new Set(pendingScopes);
    pendingScopes.clear();
    if (nextScopes.has("stats")) loadStats();
    if (nextScopes.has("charts")) loadCharts();
    if (nextScopes.has("recent")) loadRecent();
    if (nextScopes.has("queue")) loadQueue();
  }, 180);
}

function connectDashboardEvents() {
  if (typeof EventSource === "undefined") {
    setLiveStatus("error", "Push недоступен");
    return;
  }
  if (eventSource && eventSource.readyState !== EventSource.CLOSED) return;

  setLiveStatus("connecting", "Подключение");
  eventSource = new EventSource("/api/admin/events");
  eventSource.onopen = () => setLiveStatus("connected", "Обновления онлайн");
  eventSource.addEventListener("connected", () => {
    setLiveStatus("connected", "Обновления онлайн");
  });
  eventSource.addEventListener("dashboard-update", (event) => {
    try {
      const payload = JSON.parse(event.data);
      const scopes = Array.isArray(payload.scopes) ? payload.scopes : [];
      scheduleDashboardRefresh(scopes);
    } catch (error) {
      console.error("Dashboard event could not be parsed", error);
    }
  });
  eventSource.onerror = () => {
    setLiveStatus(
      eventSource.readyState === EventSource.CLOSED ? "error" : "reconnecting",
      eventSource.readyState === EventSource.CLOSED
        ? "Нет соединения"
        : "Переподключение",
    );
  };
}

async function refreshDashboardNow() {
  const button = document.getElementById("refreshNow");
  button.disabled = true;
  try {
    await Promise.all([loadStats(), loadQueue(), loadCharts(), loadRecent()]);
  } finally {
    button.disabled = false;
  }
}

window.onload = () => {
  document.getElementById("tbody").addEventListener("click", async (e) => {
    const reh = e.target.closest(".btn-cache-rehydrate");
    if (reh) {
      e.preventDefault();
      const jobId = reh.dataset.jobId;
      reh.disabled = true;
      try {
        const r = await fetch(`/api/admin/cache/rehydrate/${jobId}`, {
          method: "POST",
          credentials: "include",
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) {
          showToast(
            data.message || data.error || "Не удалось восстановить кэш",
            "error",
          );
        } else {
          showToast("Кэш обновлён", "ok");
        }
        loadRecent();
      } catch (err) {
        console.error(err);
        showToast("Ошибка сети", "error");
      } finally {
        reh.disabled = false;
      }
      return;
    }
    const btn = e.target.closest(".btn-cache-view");
    if (!btn) return;
    openCacheModal(
      btn.dataset.jobId,
      btn.dataset.kind,
      Number(btn.dataset.imageCount || 0),
    );
  });
  document
    .getElementById("cache-modal-close")
    .addEventListener("click", closeCacheModal);
  document
    .getElementById("cache-modal-overlay")
    .addEventListener("click", (e) => {
      if (e.target.id === "cache-modal-overlay") closeCacheModal();
    });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeCacheModal();
    if (!modalNavigate || !document.getElementById("cache-modal-overlay").classList.contains("open")) return;
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      modalNavigate(-1);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      modalNavigate(1);
    }
  });

  document.getElementById("refreshNow").addEventListener("click", refreshDashboardNow);
  document.addEventListener("visibilitychange", () => {
    if (docHidden()) return;
    if (!eventSource || eventSource.readyState === EventSource.CLOSED) connectDashboardEvents();
    scheduleDashboardRefresh(["stats", "queue", "charts", "recent"]);
  });

  loadStats();
  loadQueue();
  loadCharts();
  loadRecent();
  connectDashboardEvents();
};
