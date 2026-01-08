window.addEventListener("error", (e) => {
  alert("JSエラー: " + (e.message || "unknown"));
});
window.addEventListener("unhandledrejection", (e) => {
  alert("Promiseエラー: " + (e.reason?.message || e.reason || "unknown"));
});

const LS_KEY = "timeTracker.logs";
const USER_KEY = "timeTrackerUserName";

let currentTask = null;          // 稼働中ログ
let selectedDate = new Date();   // 表示中日付
let editingLogId = null;         // 編集対象のログID（新規追加はnull）
let creatingDateYMD = null;      // 新規追加対象日（YYYY-MM-DD）

document.addEventListener("DOMContentLoaded", () => {
  // 要素取得
  const dateInput = document.getElementById("dateInput");
  const prevDayBtn = document.getElementById("prevDay");
  const nextDayBtn = document.getElementById("nextDay");

  const currentStatusBox = document.getElementById("currentStatus");
  const statusText = currentStatusBox?.querySelector(".status-text");

  const categoryButtons = document.querySelectorAll(".category-btn[data-category]");
  const stopBtn = document.getElementById("stopBtn");

  const logsList = document.getElementById("logsList");
  const summary = document.getElementById("summary");

  // CSV出力ボタン
  const exportBtn = document.getElementById("exportCsv");            // 日次
  const exportMonthBtn = document.getElementById("exportCsvMonth");  // 月次
  const addLogBtn = document.getElementById("addLogBtn");            // 手入力追加

  // ユーザー名UI
  const userNameLabel = document.getElementById("userNameLabel");
  const changeUserBtn = document.getElementById("changeUserBtn");

  // モーダル要素
  const editModal = document.getElementById("editModal");
  const editCategory = document.getElementById("editCategory");
  const editStartTime = document.getElementById("editStartTime");
  const editEndTime = document.getElementById("editEndTime");
  const saveEdit = document.getElementById("saveEdit");
  const deleteLog = document.getElementById("deleteLog");
  const cancelEdit = document.getElementById("cancelEdit");

  // 安全チェック
  if (!dateInput || !statusText || !logsList || !summary || !editModal) {
    alert("HTML要素が見つかりません（idの不一致の可能性）");
    return;
  }

  // ===== ユーザー名管理 =====
  function getUserName() {
    return localStorage.getItem(USER_KEY) || "unknown";
  }
  function setUserName(name) {
    const cleaned = String(name).replace(/[\r\n,]/g, " ").trim();
    if (!cleaned) return;
    localStorage.setItem(USER_KEY, cleaned);
    updateUserNameUI();
  }
  function updateUserNameUI() {
    if (userNameLabel) userNameLabel.textContent = getUserName();
  }

  if (!localStorage.getItem(USER_KEY)) {
    const first = prompt("名前を入力してください（例：松原）");
    localStorage.setItem(USER_KEY, (first ? String(first).trim() : "unknown") || "unknown");
  }
  updateUserNameUI();

  changeUserBtn?.addEventListener("pointerup", (e) => {
    e.preventDefault();
    const current = getUserName();
    const input = prompt("名前を変更してください", current);
    if (input !== null) setUserName(input);
  });

  // 初期：今日
  dateInput.value = toYMD(new Date());
  selectedDate = fromYMD(dateInput.value);

  // 日付変更
  dateInput.addEventListener("change", () => {
    selectedDate = fromYMD(dateInput.value);
    renderAll();
  });
  prevDayBtn?.addEventListener("pointerup", (e) => {
    e.preventDefault();
    selectedDate = addDays(selectedDate, -1);
    dateInput.value = toYMD(selectedDate);
    renderAll();
  });
  nextDayBtn?.addEventListener("pointerup", (e) => {
    e.preventDefault();
    selectedDate = addDays(selectedDate, +1);
    dateInput.value = toYMD(selectedDate);
    renderAll();
  });

  // カテゴリボタン：タイマー開始（今日のみ）
  categoryButtons.forEach((btn) => {
    btn.addEventListener("pointerup", (e) => {
      e.preventDefault();
      const cat = btn.dataset.category;
      startCategory(cat);
      renderAll();
    });
  });

  // 停止
  stopBtn?.addEventListener("pointerup", (e) => {
    e.preventDefault();
    stopCurrent();
    renderAll();
  });

  // 日次CSV
  exportBtn?.addEventListener("pointerup", (e) => {
    e.preventDefault();
    exportCsvForSelectedDate();
  });

  // 月次CSV
  exportMonthBtn?.addEventListener("pointerup", (e) => {
    e.preventDefault();
    exportCsvForSelectedMonth();
  });

  // 手入力追加
  addLogBtn?.addEventListener("pointerup", (e) => {
    e.preventDefault();
    openCreateModalForSelectedDate();
  });

  // モーダル操作
  cancelEdit?.addEventListener("pointerup", (e) => {
    e.preventDefault();
    closeModal();
  });
  editModal?.addEventListener("pointerup", (e) => {
    if (e.target === editModal) closeModal();
  });

  // 保存（編集 or 新規追加）
  saveEdit?.addEventListener("pointerup", (e) => {
    e.preventDefault();

    const logs = loadLogs();
    const category = editCategory.value;
    const s = editStartTime.value;
    const en = editEndTime.value;

    if (!s) {
      alert("開始時刻が空です");
      return;
    }

    // 新規追加モード
    if (!editingLogId) {
      const d = creatingDateYMD || toYMD(selectedDate);
      const startISO = toISO(d, s);
      const endISO = en ? toISO(d, en) : null;

      if (endISO && new Date(endISO) < new Date(startISO)) {
        alert("終了時刻が開始時刻より前です");
        return;
      }

      logs.push({
        id: cryptoRandomId(),
        date: d,
        category,
        startISO,
        endISO,
      });

      saveLogs(logs);
      closeModal();
      renderAll();
      return;
    }

    // 編集モード
    const idx = logs.findIndex((x) => x.id === editingLogId);
    if (idx === -1) return;

    const d = logs[idx].date;
    const startISO = toISO(d, s);
    const endISO = en ? toISO(d, en) : null;

    if (endISO && new Date(endISO) < new Date(startISO)) {
      alert("終了時刻が開始時刻より前です");
      return;
    }

    logs[idx].category = category;
    logs[idx].startISO = startISO;
    logs[idx].endISO = endISO;

    if (currentTask && currentTask.id === editingLogId && logs[idx].endISO) {
      currentTask = null;
    }

    saveLogs(logs);
    closeModal();
    renderAll();
  });

  // 削除（編集時のみ）
  deleteLog?.addEventListener("pointerup", (e) => {
    e.preventDefault();
    if (!editingLogId) {
      alert("新規追加中のため削除はできません。キャンセルしてください。");
      return;
    }

    let logs = loadLogs();
    logs = logs.filter((x) => x.id !== editingLogId);

    if (currentTask && currentTask.id === editingLogId) {
      currentTask = null;
    }

    saveLogs(logs);
    closeModal();
    renderAll();
  });

  // 初回
  renderAll();

  // ------- 表示 -------

  function renderAll() {
    renderStatus();
    renderLogs();
    renderSummary();
  }

  function renderStatus() {
    if (!currentTask) {
      statusText.textContent = "停止中";
      return;
    }
    const start = new Date(currentTask.startISO);
    statusText.textContent =
      `作業中：${currentTask.category}（開始 ${start.toLocaleTimeString()}）`;
  }

  function renderLogs() {
    const d = toYMD(selectedDate);
    const logs = loadLogs().filter(x => x.date === d);
    logs.sort((a, b) => new Date(a.startISO) - new Date(b.startISO));
    logsList.innerHTML = "";

    if (logs.length === 0) {
      logsList.innerHTML = `<div style="opacity:.7;">ログはまだありません</div>`;
      return;
    }

    logs.forEach((log) => {
      const s = new Date(log.startISO);
      const e = log.endISO ? new Date(log.endISO) : null;
      const mins = calcMinutes(log.startISO, log.endISO);

      const row = document.createElement("div");
      row.className = "log-item";
      row.style.padding = "10px";
      row.style.border = "1px solid rgba(0,0,0,.08)";
      row.style.borderRadius = "10px";
      row.style.marginBottom = "8px";
      row.style.background = "rgba(255,255,255,.8)";

      row.innerHTML = `
        <div style="display:flex;justify-content:space-between;gap:10px;align-items:center;">
          <div>
            <div style="font-weight:700;">${log.category}</div>
            <div style="opacity:.75;font-size:12px;">
              ${fmtHM(s)} → ${e ? fmtHM(e) : "（進行中）"} / ${mins}分
            </div>
          </div>
          <button type="button" style="padding:8px 10px;border-radius:10px;border:0;cursor:pointer;">編集</button>
        </div>
      `;

      row.querySelector("button").addEventListener("pointerup", (e) => {
        e.preventDefault();
        openEditModal(log);
      });

      logsList.appendChild(row);
    });
  }

  function renderSummary() {
    const d = toYMD(selectedDate);
    const logs = loadLogs().filter((x) => x.date === d);

    const order = ["移動", "見積", "現場", "事務", "休憩"];
    const sums = Object.fromEntries(order.map((k) => [k, 0]));

    logs.forEach((log) => {
      sums[log.category] = (sums[log.category] || 0) + calcMinutes(log.startISO, log.endISO);
    });

    const total = order.reduce((acc, k) => acc + (sums[k] || 0), 0);

    summary.innerHTML = `
      <h2 style="margin:10px 0 6px;">今日の合計</h2>
      ${order.map(k => `<div style="display:flex;justify-content:space-between;">
        <div>${k}</div><div>${fmtHMFromMinutes(sums[k] || 0)}</div>
      </div>`).join("")}
      <hr style="opacity:.2;margin:8px 0;">
      <div style="display:flex;justify-content:space-between;font-weight:700;">
        <div>合計</div><div>${fmtHMFromMinutes(total)}</div>
      </div>
    `;
  }

  // ------- ログ操作 -------

  function startCategory(category) {
    const todayYMD = toYMD(new Date());
    const selectedYMD = toYMD(selectedDate);

    if (selectedYMD !== todayYMD) {
      alert("開始は今日の日付でのみ可能です（過去日は「＋手入力追加」で入力してください）");
      return;
    }

    if (currentTask) stopCurrent();

    const now = new Date();
    const newLog = {
      id: cryptoRandomId(),
      date: todayYMD,
      category,
      startISO: now.toISOString(),
      endISO: null,
    };

    const logs = loadLogs();
    logs.push(newLog);
    saveLogs(logs);

    currentTask = newLog;
  }

  function stopCurrent() {
    if (!currentTask) return;

    const logs = loadLogs();
    const idx = logs.findIndex((x) => x.id === currentTask.id);
    if (idx !== -1) {
      logs[idx].endISO = new Date().toISOString();
      saveLogs(logs);
    }
    currentTask = null;
  }

  // ------- モーダル -------

  function openEditModal(log) {
    creatingDateYMD = null;
    editingLogId = log.id;

    editCategory.value = log.category;

    const s = new Date(log.startISO);
    editStartTime.value = fmtTimeInput(s);

    if (log.endISO) {
      const e = new Date(log.endISO);
      editEndTime.value = fmtTimeInput(e);
    } else {
      editEndTime.value = "";
    }

    editModal.style.display = "block";
  }

  function openCreateModalForSelectedDate() {
    editingLogId = null;
    creatingDateYMD = toYMD(selectedDate);

    editCategory.value = "事務";
    editStartTime.value = "09:00";
    editEndTime.value = "10:00";

    editModal.style.display = "block";
  }

  function closeModal() {
    editingLogId = null;
    creatingDateYMD = null;
    editModal.style.display = "none";
  }

  // ------- CSV -------

  function exportCsvForSelectedDate() {
    const d = toYMD(selectedDate);
    const logs = loadLogs().filter((x) => x.date === d);
    logs.sort((a, b) => new Date(a.startISO) - new Date(b.startISO));

    if (logs.length === 0) {
      alert("この日のログがありません");
      return;
    }

    const userName = safeUserName(getUserName());
    const exportedAtISO = new Date().toISOString();

    const header = ["timestamp", "user", "date", "category", "start", "end", "minutes"];
    const rows = logs.map((log) => {
      const s = new Date(log.startISO);
      const e = log.endISO ? new Date(log.endISO) : null;
      return [
        exportedAtISO,
        userName,
        log.date,
        log.category,
        fmtHM(s),
        e ? fmtHM(e) : "",
        calcMinutes(log.startISO, log.endISO),
      ];
    });

    const csv = [header, ...rows].map((r) => r.map(escapeCsv).join(",")).join("\n");
    downloadCsv(csv, `time_log_${d}_${userName}.csv`);
  }

  function exportCsvForSelectedMonth() {
    const ym = toYM(selectedDate);
    const logs = loadLogs().filter((x) => String(x.date || "").startsWith(ym + "-"));
    logs.sort((a, b) => new Date(a.startISO) - new Date(b.startISO));

    if (logs.length === 0) {
      alert("この月のログがありません");
      return;
    }

    const userName = safeUserName(getUserName());
    const exportedAtISO = new Date().toISOString();

    const header = ["timestamp", "user", "date", "category", "start", "end", "minutes"];
    const rows = logs.map((log) => {
      const s = new Date(log.startISO);
      const e = log.endISO ? new Date(log.endISO) : null;
      return [
        exportedAtISO,
        userName,
        log.date,
        log.category,
        fmtHM(s),
        e ? fmtHM(e) : "",
        calcMinutes(log.startISO, log.endISO),
      ];
    });

    const csv = [header, ...rows].map((r) => r.map(escapeCsv).join(",")).join("\n");
    downloadCsv(csv, `time_log_${ym}_${userName}.csv`);
  }

  function downloadCsv(csvText, fileName) {
    // Excel文字化け対策：UTF-8 BOM
    const bom = "\uFEFF";
    const blob = new Blob([bom + csvText], { type: "text/csv;charset=utf-8;" });

    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function safeUserName(name) {
    const cleaned = String(name || "unknown").replace(/[\r\n,]/g, " ").trim() || "unknown";
    return cleaned.replace(/[\\\/:*?"<>|]/g, "").trim() || "unknown";
  }

  // ------- ユーティリティ -------

  function loadLogs() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  }

  function saveLogs(logs) {
    localStorage.setItem(LS_KEY, JSON.stringify(logs));
  }

  function calcMinutes(startISO, endISO) {
    const start = new Date(startISO).getTime();
    const end = endISO ? new Date(endISO).getTime() : Date.now();
    const diffMs = Math.max(0, end - start);
    return Math.round(diffMs / 60000);
  }

  function toYMD(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }

  function toYM(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    return `${y}-${m}`;
  }

  function fromYMD(ymd) {
    const [y, m, d] = ymd.split("-").map(Number);
    return new Date(y, m - 1, d);
  }

  function addDays(date, n) {
    const d = new Date(date);
    d.setDate(d.getDate() + n);
    return d;
  }

  function fmtHM(date) {
    const hh = String(date.getHours()).padStart(2, "0");
    const mm = String(date.getMinutes()).padStart(2, "0");
    return `${hh}:${mm}`;
  }

  function fmtTimeInput(date) {
    const hh = String(date.getHours()).padStart(2, "0");
    const mm = String(date.getMinutes()).padStart(2, "0");
    return `${hh}:${mm}`;
  }

  function fmtHMFromMinutes(mins) {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    if (h <= 0) return `${m}分`;
    return `${h}時間${m}分`;
  }

  function escapeCsv(v) {
    const s = String(v ?? "");
    if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  }

  function toISO(dateYMD, timeHHMM) {
    const [y, m, d] = dateYMD.split("-").map(Number);
    const [hh, mm] = timeHHMM.split(":").map(Number);
    const dt = new Date(y, m - 1, d, hh, mm, 0);
    return dt.toISOString();
  }

  function cryptoRandomId() {
    return `${Date.now()}_${Math.random().toString(16).slice(2)}`;
  }
});
