window.addEventListener("error", (e) => {
  alert("JSエラー: " + (e.message || "unknown"));
});
window.addEventListener("unhandledrejection", (e) => {
  alert("Promiseエラー: " + (e.reason?.message || e.reason || "unknown"));
});

const LS_KEY = "timeTracker.logs";
const USER_KEY = "timeTrackerUserName";

let currentTask = null;          // { id, date, category, startISO, endISO, note }
let selectedDate = new Date();   // Date
let editingLogId = null;         // nullなら新規追加
let creatingDateYMD = null;      // 新規追加対象日
let isSwitchingTask = false;     // 多重操作ロック

document.addEventListener("DOMContentLoaded", () => {
  // ===== Service Worker（PWA用：あってもなくてもOK）=====
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("./service-worker.js").catch(() => {});
    });
  }

  // ===== 要素取得 =====
  const dateInput = document.getElementById("dateInput");
  const prevDayBtn = document.getElementById("prevDay");
  const nextDayBtn = document.getElementById("nextDay");

  const currentStatusBox = document.getElementById("currentStatus");
  const statusText = currentStatusBox?.querySelector(".status-text");

  const categoryButtons = document.querySelectorAll(".category-btn[data-category]");
  const stopBtn = document.getElementById("stopBtn");

  const logsList = document.getElementById("logsList");
  const summary = document.getElementById("summary");

  const exportBtn = document.getElementById("exportCsv");               // 日次CSV
  const exportMonthBtn = document.getElementById("exportCsvMonth");     // 月次CSV（無くてもOK）
  const addLogBtn = document.getElementById("addLogBtn");               // 手入力追加（無くてもOK）

  const userNameLabel = document.getElementById("userNameLabel");
  const changeUserBtn = document.getElementById("changeUserBtn");

  const editModal = document.getElementById("editModal");
  const editCategory = document.getElementById("editCategory");
  const editStartTime = document.getElementById("editStartTime");
  const editEndTime = document.getElementById("editEndTime");
  const editNote = document.getElementById("editNote");                // ★備考
  const noteSuggestions = document.getElementById("noteSuggestions");  // ★候補
  const saveEdit = document.getElementById("saveEdit");
  const deleteLog = document.getElementById("deleteLog");
  const cancelEdit = document.getElementById("cancelEdit");

  // ===== 最低限の存在チェック =====
  if (!dateInput || !statusText || !logsList || !summary || !editModal || !editCategory || !editStartTime || !editEndTime) {
    alert("HTML要素が見つかりません（idの不一致の可能性）");
    return;
  }
  if (!editNote || !noteSuggestions) {
    alert("備考欄（editNote / noteSuggestions）が見つかりません。index.htmlに追加してください。");
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

  if (changeUserBtn) {
    changeUserBtn.onpointerup = (e) => {
      e.preventDefault();
      const current = getUserName();
      const input = prompt("名前を変更してください", current);
      if (input !== null) setUserName(input);
    };
  }

  // ===== 日付初期化 =====
  dateInput.value = toYMD(new Date());
  selectedDate = fromYMD(dateInput.value);

  // 起動時：もし進行中ログが複数あれば最新だけ残す（壊れたデータ掃除）
  enforceSingleRunningLog();

  // ===== イベント（上書き方式：二重登録対策）=====
  dateInput.onchange = () => {
    selectedDate = fromYMD(dateInput.value);
    renderAll();
  };

  if (prevDayBtn) {
    prevDayBtn.onpointerup = (e) => {
      e.preventDefault();
      selectedDate = addDays(selectedDate, -1);
      dateInput.value = toYMD(selectedDate);
      renderAll();
    };
  }

  if (nextDayBtn) {
    nextDayBtn.onpointerup = (e) => {
      e.preventDefault();
      selectedDate = addDays(selectedDate, +1);
      dateInput.value = toYMD(selectedDate);
      renderAll();
    };
  }

  // カテゴリ開始
  categoryButtons.forEach((btn) => {
    btn.onpointerup = (e) => {
      e.preventDefault();
      startCategory(btn.dataset.category);
      renderAll();
    };
  });

  // 停止
  if (stopBtn) {
    stopBtn.onpointerup = (e) => {
      e.preventDefault();
      stopCurrent();
      renderAll();
    };
  }

  // 日次CSV
  if (exportBtn) {
    exportBtn.onpointerup = (e) => {
      e.preventDefault();
      exportCsvForSelectedDate();
    };
  }

  // 月次CSV（ボタンがある人だけ）
  if (exportMonthBtn) {
    exportMonthBtn.onpointerup = (e) => {
      e.preventDefault();
      exportCsvForSelectedMonth();
    };
  }

  // 手入力追加（ボタンがある人だけ）
  if (addLogBtn) {
    addLogBtn.onpointerup = (e) => {
      e.preventDefault();
      openCreateModalForSelectedDate();
    };
  }

  // モーダル：背景タップで閉じる
  editModal.onpointerup = (e) => {
    if (e.target === editModal) closeModal();
  };

  if (cancelEdit) {
    cancelEdit.onpointerup = (e) => {
      e.preventDefault();
      closeModal();
    };
  }

  // カテゴリ変更で候補切替
  editCategory.onchange = () => {
    renderNoteSuggestions({ onlyGenba: editCategory.value === "現場" });
  };

  // 保存（編集 or 新規追加）
  if (saveEdit) {
    saveEdit.onpointerup = (e) => {
      e.preventDefault();

      const logs = loadLogs();
      const category = editCategory.value;
      const s = editStartTime.value;
      const en = editEndTime.value;
      const note = String(editNote.value || "").trim();

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
          note, // ★備考
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
      logs[idx].note = note; // ★備考

      // 進行中を編集で終了させたら currentTask を解除
      if (currentTask && currentTask.id === editingLogId && logs[idx].endISO) {
        currentTask = null;
      }

      saveLogs(logs);
      closeModal();
      renderAll();
    };
  }

  // 削除
  if (deleteLog) {
    deleteLog.onpointerup = (e) => {
      e.preventDefault();
      if (!editingLogId) {
        alert("新規追加中は削除できません。キャンセルしてください。");
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
    };
  }

  // ===== 初回レンダリング =====
  renderAll();

  // ============================
  // 主要ロジック
  // ============================

  function renderAll() {
    // 進行中が複数になってしまったデータを毎回整える（Web版の事故対策）
    enforceSingleRunningLog();

    renderStatus();
    renderLogs();
    renderSummary();
  }

  function startCategory(category) {
    if (isSwitchingTask) return;
    isSwitchingTask = true;

    const todayYMD = toYMD(new Date());
    const selectedYMD = toYMD(selectedDate);

    if (selectedYMD !== todayYMD) {
      alert("開始は今日の日付でのみ可能です（過去日は「＋手入力追加」で入力してください）");
      isSwitchingTask = false;
      return;
    }

    // まず既存の進行中を止める（currentTaskに依存しない）
    closeAllRunningLogs();

    const now = new Date();
    const newLog = {
      id: cryptoRandomId(),
      date: todayYMD,
      category,
      startISO: now.toISOString(),
      endISO: null,
      note: "", // ★備考
    };

    const logs = loadLogs();
    logs.push(newLog);
    saveLogs(logs);

    currentTask = newLog;

    setTimeout(() => {
      isSwitchingTask = false;
    }, 250);
  }

  function stopCurrent() {
    // currentTaskがnullでも「進行中」を止める
    closeAllRunningLogs();
    currentTask = null;
  }

  function closeAllRunningLogs() {
    const logs = loadLogs();
    const nowISO = new Date().toISOString();
    let changed = false;

    for (const log of logs) {
      if (!log.endISO) {
        log.endISO = nowISO;
        changed = true;
      }
    }

    if (changed) saveLogs(logs);
  }

  function enforceSingleRunningLog() {
    const logs = loadLogs();
    const runningIdx = [];
    for (let i = 0; i < logs.length; i++) {
      if (!logs[i].endISO) runningIdx.push(i);
    }
    if (runningIdx.length === 0) {
      currentTask = null;
      return;
    }
    if (runningIdx.length === 1) {
      currentTask = logs[runningIdx[0]];
      return;
    }

    // startISOが新しいものを残す
    runningIdx.sort((a, b) => new Date(logs[a].startISO) - new Date(logs[b].startISO));
    const keepIdx = runningIdx[runningIdx.length - 1];

    const nowISO = new Date().toISOString();
    for (const idx of runningIdx) {
      if (idx !== keepIdx) logs[idx].endISO = nowISO;
    }
    saveLogs(logs);
    currentTask = logs[keepIdx];
  }

  // ============================
  // 表示
  // ============================

  function renderStatus() {
    if (!currentTask) {
      statusText.textContent = "停止中";
      return;
    }
    const start = new Date(currentTask.startISO);
    statusText.textContent = `作業中：${currentTask.category}（開始 ${start.toLocaleTimeString()}）`;
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
      const note = String(log.note || "").trim();

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
            <div style="font-weight:700;">${escapeHtml(log.category)}</div>
            <div style="opacity:.75;font-size:12px;">
              ${fmtHM(s)} → ${e ? fmtHM(e) : "（進行中）"} / ${mins}分
            </div>
            ${note ? `<div style="opacity:.7;font-size:12px;margin-top:4px;">📝 ${escapeHtml(note)}</div>` : ""}
          </div>
          <button type="button" style="padding:8px 10px;border-radius:10px;border:0;cursor:pointer;">編集</button>
        </div>
      `;

      const editBtn = row.querySelector("button");
      editBtn.onpointerup = (ev) => {
        ev.preventDefault();
        openEditModal(log);
      };

      logsList.appendChild(row);
    });
  }

  function renderSummary() {
    const d = toYMD(selectedDate);
    const logs = loadLogs().filter((x) => x.date === d);

    const order = ["移動", "見積", "現場", "事務", "休憩"];
    const sums = Object.fromEntries(order.map((k) => [k, 0]));

    logs.forEach((log) => {
      const cat = log.category;
      sums[cat] = (sums[cat] || 0) + calcMinutes(log.startISO, log.endISO);
    });

    const total = order.reduce((acc, k) => acc + (sums[k] || 0), 0);

    summary.innerHTML = `
      <h2 style="margin:10px 0 6px;">今日の合計</h2>
      ${order.map(k => `<div style="display:flex;justify-content:space-between;">
        <div>${escapeHtml(k)}</div><div>${fmtHMFromMinutes(sums[k] || 0)}</div>
      </div>`).join("")}
      <hr style="opacity:.2;margin:8px 0;">
      <div style="display:flex;justify-content:space-between;font-weight:700;">
        <div>合計</div><div>${fmtHMFromMinutes(total)}</div>
      </div>
    `;
  }

  // ============================
  // モーダル
  // ============================

  function openEditModal(log) {
    editingLogId = log.id;
    creatingDateYMD = null;

    editCategory.value = log.category;

    const s = new Date(log.startISO);
    editStartTime.value = fmtTimeInput(s);

    if (log.endISO) {
      const e = new Date(log.endISO);
      editEndTime.value = fmtTimeInput(e);
    } else {
      editEndTime.value = "";
    }

    editNote.value = log.note || "";

    // 候補更新：現場なら現場候補を優先
    renderNoteSuggestions({ onlyGenba: log.category === "現場" });

    editModal.style.display = "block";

    if (log.category === "現場") {
      setTimeout(() => editNote.focus(), 50);
    }
  }

  function openCreateModalForSelectedDate() {
    editingLogId = null;
    creatingDateYMD = toYMD(selectedDate);

    editCategory.value = "事務";
    editStartTime.value = "09:00";
    editEndTime.value = "10:00";
    editNote.value = "";

    renderNoteSuggestions({ onlyGenba: true });

    editModal.style.display = "block";
  }

  function closeModal() {
    editingLogId = null;
    creatingDateYMD = null;
    editModal.style.display = "none";
  }

  // ============================
  // 備考候補（datalist）
  // ============================

  function buildRecentNoteSuggestions(limit = 10, onlyGenba = false) {
    const logs = loadLogs();
    const sorted = [...logs].sort((a, b) => new Date(b.startISO) - new Date(a.startISO));

    const seen = new Set();
    const result = [];

    for (const log of sorted) {
      if (onlyGenba && log.category !== "現場") continue;

      const note = String(log.note || "").trim();
      if (!note) continue;

      if (!seen.has(note)) {
        seen.add(note);
        result.push(note);
        if (result.length >= limit) break;
      }
    }
    return result;
  }

  function renderNoteSuggestions({ onlyGenba = false } = {}) {
    const notes = buildRecentNoteSuggestions(10, onlyGenba);
    noteSuggestions.innerHTML = "";
    for (const n of notes) {
      const opt = document.createElement("option");
      opt.value = n;
      noteSuggestions.appendChild(opt);
    }
  }

  // ============================
  // CSV
  // ============================

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

    const header = ["timestamp", "user", "date", "category", "start", "end", "minutes", "note"];
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
        log.note || "",
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

    const header = ["timestamp", "user", "date", "category", "start", "end", "minutes", "note"];
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
        log.note || "",
      ];
    });

    const csv = [header, ...rows].map((r) => r.map(escapeCsv).join(",")).join("\n");
    downloadCsv(csv, `time_log_${ym}_${userName}.csv`);
  }

  function downloadCsv(csvText, fileName) {
    const bom = "\uFEFF"; // Excel文字化け対策
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

  // ============================
  // Util
  // ============================

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

  function safeUserName(name) {
    const cleaned = String(name || "unknown").replace(/[\r\n,]/g, " ").trim() || "unknown";
    return cleaned.replace(/[\\\/:*?"<>|]/g, "").trim() || "unknown";
  }

  function escapeHtml(str) {
    return String(str ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }
});
