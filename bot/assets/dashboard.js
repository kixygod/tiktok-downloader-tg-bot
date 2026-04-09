const PAGE_SIZE = 30;
let page = 0,
  totalRows = 0;
let chartsInited = false;
let chartMissingLogged = false;
let dailyC, hourlyC, perfC, platformC, statusC, trafficC;

let loadStatsBusy = false;
let loadQueueBusy = false;
let loadChartsBusy = false;
let loadRecentBusy = false;
let modalFocusTrapCleanup = null;
let focusBeforeModal = null;

function docHidden() {
  return document.visibilityState === "hidden";
}

const chartDefaults = {
  responsive: true,
  maintainAspectRatio: false,
  plugins: {
    legend: { display: false },
    tooltip: {
      backgroundColor: "#1a2035",
      titleColor: "#e2e8f0",
      bodyColor: "#cbd5e1",
      borderColor: "#232d45",
      borderWidth: 1,
      padding: 10,
      cornerRadius: 8,
    },
  },
  scales: {
    x: {
      grid: { color: "rgba(35,45,69,.6)" },
      ticks: { color: "#64748b", font: { size: 11 } },
    },
    y: {
      grid: { color: "rgba(35,45,69,.6)" },
      ticks: { color: "#64748b", font: { size: 11 } },
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
    }[p] ||
    p ||
    "—"
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
  if (docHidden() || loadQueueBusy) return;
  loadQueueBusy = true;
  try {
    const r = await fetch("/api/queue", { credentials: "include" });
    const d = await r.json();
    if (!r.ok) {
      showToast("Очередь: ошибка ответа сервера", "error");
      return;
    }
    document.getElementById("queueStatus").textContent =
      "очередь: " +
      d.waiting +
      " | в работе: " +
      d.active +
      (d.failed ? " | ошибок: " + d.failed : "");
  } catch (e) {
    console.error(e);
    showToast("Очередь: нет сети", "error");
  } finally {
    loadQueueBusy = false;
  }
}
async function loadStats() {
  if (docHidden() || loadStatsBusy) return;
  loadStatsBusy = true;
  try {
    const r = await fetch("/api/stats", { credentials: "include" });
    const d = await r.json();
    if (!r.ok) {
      setDashBanner(
        "Статистика не загрузилась (401/403 — перелогиньтесь в дашборд).",
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
      "обновлено " + new Date().toLocaleTimeString("ru");
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
        "<div class='row'><span>—</span></div>";
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
        "<div class='row'><span>—</span></div>";
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
        "<div class='row'><span>—</span></div>";
    }
  } catch (e) {
    console.error(e);
    setDashBanner("Статистика: ошибка сети.");
    document.getElementById("kpi-row")?.classList.remove("kpi-row--loading");
  } finally {
    loadStatsBusy = false;
  }
}

async function loadCharts() {
  if (docHidden() || loadChartsBusy) return;
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
          backgroundColor: "rgba(6,182,212,.6)",
          borderRadius: 4,
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
          backgroundColor: "rgba(34,197,94,.6)",
          borderRadius: 4,
        },
        {
          label: "Ошибки",
          data: data.map((d) => d.failed || 0),
          backgroundColor: "rgba(239,68,68,.6)",
          borderRadius: 4,
        },
      ],
    },
    options: {
      ...chartDefaults,
      plugins: {
        ...chartDefaults.plugins,
        legend: {
          display: true,
          labels: { color: "#94a3b8", font: { size: 11 } },
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
          borderColor: "#6366f1",
          backgroundColor: "rgba(99,102,241,.1)",
          fill: true,
          tension: 0.3,
          pointRadius: 3,
          pointBackgroundColor: "#6366f1",
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
          borderColor: "#f59e0b",
          backgroundColor: "rgba(245,158,11,.1)",
          fill: true,
          tension: 0.3,
          pointRadius: 3,
          pointBackgroundColor: "#f59e0b",
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
  const colors = ["#6366f1", "#ef4444", "#06b6d4", "#f59e0b", "#22c55e"];
  const cfg = {
    type: "doughnut",
    data: {
      labels: data.map((d) => String(platformLabel(d.platform))),
      datasets: [
        {
          data: data.map((d) => Number(d.count)),
          backgroundColor: colors.slice(0, data.length),
          borderWidth: 0,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          position: "bottom",
          labels: { color: "#94a3b8", font: { size: 11 }, padding: 14 },
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
    success: "#22c55e",
    cached: "#a78bfa",
    compressed: "#f59e0b",
    too_large: "#06b6d4",
    failed: "#ef4444",
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
          backgroundColor: data.map((d) => cmap[d.status] || "#64748b"),
          borderWidth: 0,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          position: "bottom",
          labels: { color: "#94a3b8", font: { size: 11 }, padding: 14 },
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
  if (docHidden() || loadRecentBusy) return;
  loadRecentBusy = true;
  const status = document.getElementById("f-status").value;
  const platform = document.getElementById("f-platform").value;
  const chat_id = document.getElementById("f-chat").value.trim();
  const params = new URLSearchParams({
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
  });
  if (status) params.set("status", status);
  if (platform) params.set("platform", platform);
  if (chat_id) params.set("chat_id", chat_id);

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
    tbody.innerHTML = items
      .map((j) => {
        const url = j.url || "";
        const urlDisplay = url
          ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(url)}</a>`
          : "—";
        const err = j.error_message
          ? escapeHtml(String(j.error_message).slice(0, 80))
          : "";
        const userName =
          j.first_name ||
          j.username ||
          (j.user_id ? "id" + j.user_id : "") ||
          j.chat_id ||
          "—";
        const userLink = j.userProfileUrl
          ? `<a href="${escapeHtml(j.userProfileUrl)}" target="_blank" rel="noopener" class="user-name">${escapeHtml(userName)}</a>`
          : `<span class="user-name">${escapeHtml(userName)}</span>`;
        const avInit = escapeHtml(userAvatarInitial(userName));
        const avatarHtml = j.user_id
          ? `<img class="user-avatar" src="/api/avatar/${j.user_id}" alt="" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.classList.add('user-avatar-placeholder--visible');" /><span class="user-avatar-placeholder" aria-hidden="true">${avInit}</span>`
          : `<span class="user-avatar-placeholder user-avatar-placeholder--visible user-avatar-placeholder--empty">${avInit}</span>`;
        const chatTitle =
          j.chatTitle || (j.chat_id ? "Chat " + j.chat_id : "—");
        const chatLink = j.chatUrl
          ? `<a href="${escapeHtml(j.chatUrl)}" target="_blank" rel="noopener">${escapeHtml(chatTitle)}</a>`
          : escapeHtml(chatTitle);
        const chatBadge = j.chatType
          ? `<span class="chat-type-badge">${chatTypeLabel(j.chatType)}</span> `
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
          cacheCell = `<button type="button" class="btn-cache-view" data-job-id="${j.id}" data-kind="${cp.kind}" data-image-count="${cp.imageCount || 0}">${escapeHtml(lbl)}</button>`;
        } else {
          cacheCell = `<span class="cache-miss-wrap"><span class="cache-miss" title="Нет в кэше или истёк срок (до ~24 ч)">—</span><button type="button" class="btn-cache-rehydrate" title="Восстановить связь с кэшем на диске (обновить Redis)" data-job-id="${j.id}" aria-label="Восстановить кэш">↻</button></span>`;
        }
        return `<tr>
<td>${fmtTime(j.ts)}</td>
<td><div class="user-cell">${avatarHtml}${userLink}</div></td>
<td>${chatBadge}${chatLink}</td>
<td>${escapeHtml(platformLabel(j.platform))}</td>
<td class="url-cell" title="${escapeHtml(url)}">${urlDisplay}</td>
<td>${statusBadge(j.status)}</td>
<td>${fmtBytes(j.bytes)}</td>
<td>${fmtMs(j.duration_ms)}</td>
<td class="cache-cell">${cacheCell}</td>
<td class="error-cell" title="${err}">${err || "—"}</td>
    </tr>`;
      })
      .join("");

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
let chatTimer;
document.getElementById("f-chat").oninput = () => {
  clearTimeout(chatTimer);
  chatTimer = setTimeout(() => {
    page = 0;
    loadRecent();
  }, 400);
};

let cacheModalBlobUrls = [];

function revokeCacheModalUrls() {
  cacheModalBlobUrls.forEach((u) => URL.revokeObjectURL(u));
  cacheModalBlobUrls = [];
}

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
  }
  body.innerHTML = '<span class="cache-modal-loading">Загрузка…</span>';
  revokeCacheModalUrls();
  if (focusBeforeModal && typeof focusBeforeModal.focus === "function") {
    try {
      focusBeforeModal.focus();
    } catch (_) {}
  }
  focusBeforeModal = null;
}

async function openCacheModal(jobId, kind, imageCount) {
  focusBeforeModal = document.activeElement;
  revokeCacheModalUrls();
  const overlay = document.getElementById("cache-modal-overlay");
  const body = document.getElementById("cache-modal-body");
  overlay.classList.add("open");
  overlay.setAttribute("aria-hidden", "false");
  body.innerHTML = '<span class="cache-modal-loading">Загрузка…</span>';
  installModalFocusTrap();
  requestAnimationFrame(() => focusModalClose());

  try {
    if (kind === "video") {
      const r = await fetch(`/api/admin/cache/${jobId}/video`, {
        credentials: "include",
      });
      if (!r.ok) {
        body.innerHTML = `<span class="cache-miss">Не удалось загрузить (HTTP ${r.status})</span>`;
        requestAnimationFrame(() => focusModalClose());
        return;
      }
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      cacheModalBlobUrls.push(url);
      body.innerHTML = "";
      const vid = document.createElement("video");
      vid.controls = true;
      vid.playsInline = true;
      vid.tabIndex = 0;
      vid.src = url;
      body.appendChild(vid);
      requestAnimationFrame(() => {
        try {
          vid.focus();
        } catch (_) {
          focusModalClose();
        }
      });
    } else {
      const n = Math.max(1, Number(imageCount) || 1);
      let current = 0;
      let lastImgUrl = null;
      const wrap = document.createElement("div");
      wrap.className = "cache-carousel";
      const img = document.createElement("img");
      img.alt = "";
      const nav = document.createElement("div");
      nav.className = "cache-carousel-nav";
      const prev = document.createElement("button");
      prev.type = "button";
      prev.textContent = "← Назад";
      const label = document.createElement("span");
      label.style.cssText =
        "align-self:center;color:var(--muted);font-size:0.8rem;padding:0 8px";
      const next = document.createElement("button");
      next.type = "button";
      next.textContent = "Вперёд →";
      const dots = document.createElement("div");
      dots.className = "cache-carousel-dots";

      async function showIndex(i) {
        if (i < 0 || i >= n) return;
        current = i;
        const r = await fetch(`/api/admin/cache/${jobId}/image/${i}`, {
          credentials: "include",
        });
        if (!r.ok) {
          img.removeAttribute("src");
          img.alt = "Ошибка загрузки";
          return;
        }
        const blob = await r.blob();
        if (lastImgUrl) {
          URL.revokeObjectURL(lastImgUrl);
          const ix = cacheModalBlobUrls.indexOf(lastImgUrl);
          if (ix >= 0) cacheModalBlobUrls.splice(ix, 1);
        }
        lastImgUrl = URL.createObjectURL(blob);
        cacheModalBlobUrls.push(lastImgUrl);
        img.src = lastImgUrl;
        label.textContent = `${i + 1} / ${n}`;
        prev.disabled = i <= 0;
        next.disabled = i >= n - 1;
        dots.querySelectorAll("span").forEach((d, di) => {
          d.classList.toggle("active", di === i);
        });
      }

      prev.onclick = () => showIndex(current - 1);
      next.onclick = () => showIndex(current + 1);
      for (let di = 0; di < n; di++) {
        const dot = document.createElement("span");
        dot.onclick = () => showIndex(di);
        if (di === 0) dot.classList.add("active");
        dots.appendChild(dot);
      }
      nav.appendChild(prev);
      nav.appendChild(label);
      nav.appendChild(next);
      wrap.appendChild(img);
      wrap.appendChild(nav);
      wrap.appendChild(dots);
      body.innerHTML = "";
      body.appendChild(wrap);
      await showIndex(0);
      requestAnimationFrame(() => focusModalClose());
    }
  } catch (e) {
    console.error(e);
    document.getElementById("cache-modal-body").innerHTML =
      '<span class="cache-miss">Ошибка сети</span>';
    requestAnimationFrame(() => focusModalClose());
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
  });

  loadStats();
  loadQueue();
  loadCharts();
  loadRecent();
  setInterval(() => {
    if (!docHidden()) loadStats();
  }, 15000);
  setInterval(() => {
    if (!docHidden()) loadQueue();
  }, 5000);
  setInterval(() => {
    if (!docHidden()) loadCharts();
  }, 30000);
  setInterval(() => {
    if (!docHidden()) loadRecent();
  }, 15000);
};
