// 云记事 Windows 端前端
// 笔迹格式 v2（与鸿蒙端一致）：
// {format:'harmonynote-ink',version:2,canvasW,canvasH,strokes:[...],
//  pages:[{w,h,strokes:[{color,width,points:[[x,y,p,t]...]}]}]}
// canvasW/H/strokes 为第 1 页镜像，兼容旧版本；旧文件没有 pages 时自动按单页解析。
"use strict";

const API = "http://127.0.0.1:8787";
const $ = (id) => document.getElementById(id);

const state = {
  dir: "",
  notes: [],
  active: null,
  tab: "notes", // notes / groups / history / trash（笔迹缩放用的 state.view 不能占用）
  trash: false,
  batch: false,
  sel: [],
  groups: [],
  inkDoc: null,
  inkPage: 0,
  textPages: [""],
  textPage: 0,
  view: { s: 1, ox: 0, oy: 0 },
  sig: "",
  menuId: null,
  modalOk: null,
  modalHasInput: false
};

// ---------------- 操作记录（与鸿蒙端同一数据结构，随笔记文件互通） ----------------

const ACT_LABEL = {
  create: "新建", edit: "修改", move: "移动", copy: "复制",
  trash: "删除", restore: "恢复", purge: "彻底删除"
};

/** 高频 edit 合并：同设备、同类型、10 分钟内只刷新时间 */
function pushHist(note, act, detail) {
  const hist = Array.isArray(note.history) ? note.history.slice(0) : [];
  const now = Date.now();
  const last = hist.length ? hist[hist.length - 1] : null;
  if (last && last.act === act && last.dev === "windows-pc" && now - last.t < 600000) {
    hist[hist.length - 1] = { t: now, act: act, detail: detail, dev: "windows-pc" };
  } else {
    hist.push({ t: now, act: act, detail: detail, dev: "windows-pc" });
    if (hist.length > 50) hist.splice(0, hist.length - 50);
  }
  note.history = hist;
}

async function readGroupsFile() {
  try {
    const gf = await readJson("_groups.json");
    return Array.isArray(gf.groups) ? gf.groups.filter(g => g) : [];
  } catch (e) {
    return [];
  }
}

async function writeGroupsFile(list) {
  try {
    await writeJson("_groups.json", { groups: list });
  } catch (e) { /* 服务未起时忽略 */ }
}

async function appendGlobalLog(entry) {
  let list = [];
  try {
    const r = await readJson("_history.json");
    if (Array.isArray(r)) list = r;
  } catch (e) { /* 不存在则新建 */ }
  list.push(entry);
  if (list.length > 200) list.splice(0, list.length - 200);
  try {
    await writeJson("_history.json", list);
  } catch (e) { /* 忽略 */ }
}

async function loadGroups() {
  const fromFile = await readGroupsFile();
  const set = new Set(fromFile);
  for (const n of state.notes) {
    if (n.group) set.add(n.group);
  }
  state.groups = Array.from(set);
}

// ---------------- 文件访问（全部走本地 HTTP 服务） ----------------

async function readJson(name) {
  const r = await fetch(`${API}/api/files/${encodeURIComponent(name)}`, { cache: "no-store" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return JSON.parse(await r.text());
}

async function writeJson(name, obj) {
  const r = await fetch(`${API}/api/files/${encodeURIComponent(name)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/octet-stream" },
    body: JSON.stringify(obj)
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
}

async function deleteRemote(name) {
  try {
    await fetch(`${API}/api/files/${encodeURIComponent(name)}`, { method: "DELETE" });
  } catch (e) { /* 文件不存在也无所谓 */ }
}

// ---------------- 列表 ----------------

async function scanNotes() {
  let notes = [];
  let err = "";
  try {
    notes = await window.__TAURI__.core.invoke("list_notes");
  } catch (e) {
    err = e && e.message ? e.message : String(e);
  }
  state.notes = Array.isArray(notes) ? notes : [];
  await loadGroups();

  const active = state.notes.filter(n => !n.deleted).length;
  const trash = state.notes.filter(n => n.deleted).length;
  $("cnt-notes").textContent = active;
  $("cnt-trash").textContent = trash;

  // 选中项被彻底删除时收起编辑区
  if (state.active && !state.notes.some(n => n.id === state.active)) {
    closeEditors();
  }

  const sig = state.notes
    .map(n => `${n.id}:${n.version || 0}:${n.deleted ? 1 : 0}:${n.title || ""}:${n.group || ""}`)
    .sort()
    .join("|");
  if (sig !== state.sig || state.tab === "history") {
    state.sig = sig;
    renderList();
  }
  if (err) $("srv-info").textContent = "读取失败：" + err;
}

function renderList() {
  const ul = $("note-list");
  ul.innerHTML = "";

  // 历史视图：主区显示记录，侧栏列表隐藏
  if (state.tab === "history") {
    $("empty").classList.add("hidden");
    $("historyview").classList.remove("hidden");
    renderHistory();
    return;
  }
  $("historyview").classList.add("hidden");
  if (!state.active && state.tab !== "groups") {
    $("empty").classList.remove("hidden");
  }

  const list = state.notes
    .filter(n => state.tab === "trash" ? n.deleted : !n.deleted)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

  if (state.tab === "groups") {
    renderGroupedList(ul, list);
    return;
  }

  if (list.length === 0) {
    const li = document.createElement("li");
    li.className = "empty-li";
    li.innerHTML = state.tab === "trash"
      ? "回收站是空的<br><span>删除的笔记会先放在这里</span>"
      : "还没有笔记<br><span>点左下角新建，或手机「同步到电脑」</span>";
    ul.appendChild(li);
    return;
  }

  for (const n of list) {
    ul.appendChild(makeNoteItem(n));
  }
}

/** 生成一条笔记列表项（复选框按批量模式显隐） */
function makeNoteItem(n) {
  const li = document.createElement("li");
  li.dataset.id = n.id;
  if (n.id === state.active) li.classList.add("active");
  li.innerHTML = `
    <input type="checkbox" class="pick ${state.batch ? "" : "hidden"}" ${state.sel.indexOf(n.id) >= 0 ? "checked" : ""}>
    <div class="li-main">
      <div class="ico">${n.type === 1 ? "✍️" : "📝"}</div>
      <div class="txt">
        <div class="t">${esc(n.title || "未命名")}</div>
        <div class="m">${n.type === 1 ? "手写" : "文字"}${n.group ? " · " + esc(n.group) : ""} · ${fmt(n.updatedAt)}${n.deleted ? " · 已删除" : ""}</div>
      </div>
    </div>
    <button class="more" title="更多操作">⋯</button>`;
  li.querySelector(".li-main").onclick = () => {
    if (state.batch && !n.deleted) {
      toggleSel(n.id);
      renderList();
      return;
    }
    openNote(n.id);
  };
  li.querySelector(".pick").onchange = () => toggleSel(n.id);
  li.querySelector(".more").onclick = (ev) => {
    ev.stopPropagation();
    showMenu(n.id, ev.currentTarget);
  };
  return li;
}

/** 分组视图：未分组 + 各组聚簇展示 */
function renderGroupedList(ul, list) {
  const buckets = [["未分组", list.filter(n => !n.group)]];
  for (const g of state.groups) {
    buckets.push([g, list.filter(n => n.group === g)]);
  }
  let shown = 0;
  for (const [g, items] of buckets) {
    const head = document.createElement("li");
    head.className = "group-head";
    head.innerHTML = `<span class="g-ico">📁</span> ${esc(g)} <span class="badge">${items.length}</span>`;
    ul.appendChild(head);
    for (const n of items) {
      ul.appendChild(makeNoteItem(n));
      shown++;
    }
    if (items.length === 0) {
      const li = document.createElement("li");
      li.className = "empty-li";
      li.innerHTML = "<span>空分组 · 在笔记的 ⋯ 菜单里「移动 / 复制到分组」</span>";
      ul.appendChild(li);
    }
  }
  if (shown === 0 && state.notes.length === 0) {
    const li = document.createElement("li");
    li.className = "empty-li";
    li.innerHTML = "还没有笔记<br><span>点左下角新建，或手机「同步到电脑」</span>";
    ul.appendChild(li);
  }
}

/** 历史视图（主区）：全部笔记内嵌记录 + 全局日志，按时间倒序 */
function renderHistory() {
  const ul = $("hist-list");
  ul.innerHTML = "";
  const all = [];
  for (const n of state.notes) {
    if (Array.isArray(n.history)) {
      for (const e of n.history) all.push(e);
    }
  }
  // 全局日志（彻底删除等文件已不存在的事件）在主区异步补齐
  fetch(`${API}/api/files/${encodeURIComponent("_history.json")}`, { cache: "no-store" })
    .then(r => r.ok ? r.json() : [])
    .then(g => {
      if (Array.isArray(g)) {
        for (const e of g) {
          if (!all.some(x => x.t === e.t && x.act === e.act && x.detail === e.detail)) all.push(e);
        }
      }
      all.sort((a, b) => b.t - a.t);
      for (const e of all.slice(0, 200)) {
        const li = document.createElement("li");
        li.className = "hist-item";
        li.innerHTML = `
          <span class="act ${esc(e.act)}">${ACT_LABEL[e.act] || esc(e.act)}</span>
          <div class="h-txt">
            <div class="d">${esc(e.detail || "")}</div>
            <div class="m">${fmtFull(e.t)} · ${e.dev === "windows-pc" ? "本机" : esc(e.dev || "-")}</div>
          </div>`;
        ul.appendChild(li);
      }
      if (all.length === 0) {
        ul.innerHTML = '<li class="empty-li"><span>还没有操作记录</span></li>';
      }
    })
    .catch(() => { });
}

function fmtFull(t) {
  if (!t) return "-";
  const d = new Date(t);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}

function toggleSel(id) {
  const i = state.sel.indexOf(id);
  if (i >= 0) state.sel.splice(i, 1);
  else state.sel.push(id);
  const b = $("btn-batch-del");
  b.textContent = `删除所选 (${state.sel.length})`;
  b.classList.toggle("hidden", !state.batch || state.sel.length === 0);
}

function esc(s) {
  const d = document.createElement("div");
  d.textContent = s == null ? "" : String(s);
  return d.innerHTML;
}

function uuid() {
  if (window.crypto && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    return (c === "x" ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

function fmt(t) {
  if (!t) return "-";
  const d = new Date(t);
  return `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

// ---------------- 打开笔记 ----------------

async function openNote(id) {
  const meta = state.notes.find(n => n.id === id);
  if (!meta) return;
  state.active = id;
  hideMenu();
  renderList();
  $("empty").classList.add("hidden");
  if (meta.type === 1) {
    await openInk(meta);
  } else {
    await openText(meta);
  }
}

async function openText(meta) {
  $("inkview").classList.add("hidden");
  $("editor").classList.remove("hidden");

  let d = meta;
  let err = "";
  try {
    const full = await readJson(`${meta.id}.json`);
    if (full) d = full;
  } catch (e) {
    err = e.message;
  }
  state.textPages = Array.isArray(d.pages) && d.pages.length ? d.pages.slice() : [d.content || ""];
  state.textPage = 0;
  $("ed-title").value = d.title || "";
  renderTextPage();
  $("ed-meta").textContent = err
    ? `读取失败：${err}（文件可能刚被移走，稍后会自动刷新）`
    : `更新于 ${fmt(d.updatedAt)} · v${d.version || 1} · 来源 ${d.deviceId || "-"}`;
}

/** 文字笔记分页栏：页码按钮 + 加页 */
function renderTextPages() {
  const bar = $("ed-pages");
  bar.innerHTML = "";
  state.textPages.forEach((p, i) => {
    const b = document.createElement("button");
    b.textContent = String(i + 1);
    if (i === state.textPage) b.className = "cur";
    b.onclick = () => switchTextPage(i);
    bar.appendChild(b);
  });
  const add = document.createElement("button");
  add.textContent = "＋ 加页";
  add.onclick = () => addTextPage();
  bar.appendChild(add);
}

function renderTextPage() {
  renderTextPages();
  $("ed-content").value = state.textPages[state.textPage] || "";
  $("ed-tip").textContent = `第 ${state.textPage + 1}/${state.textPages.length} 页 · 已保存到本机；手机端回到 App 会自动接收`;
}

function switchTextPage(i) {
  // 先把当前输入框内容写回，避免切换丢字
  state.textPages[state.textPage] = $("ed-content").value;
  state.textPage = i;
  renderTextPage();
}

function addTextPage() {
  state.textPages[state.textPage] = $("ed-content").value;
  state.textPages.push("");
  state.textPage = state.textPages.length - 1;
  renderTextPage();
  saveText();
  $("ed-content").focus();
}

/** 兼容旧格式（单页）并补齐 pages 字段 */
function normInkDoc(doc) {
  if (!doc || typeof doc !== "object") doc = {};
  if (Array.isArray(doc.pages) && doc.pages.length) {
    doc.pages = doc.pages.map((p) => ({
      w: p && p.w > 0 ? p.w : 900,
      h: p && p.h > 0 ? p.h : 1200,
      strokes: p && Array.isArray(p.strokes) ? p.strokes : []
    }));
  } else {
    doc.pages = [{
      w: doc.canvasW > 0 ? doc.canvasW : 1080,
      h: doc.canvasH > 0 ? doc.canvasH : 1920,
      strokes: Array.isArray(doc.strokes) ? doc.strokes : []
    }];
  }
  doc.format = "harmonynote-ink";
  doc.version = 2;
  doc.canvasW = doc.pages[0].w;
  doc.canvasH = doc.pages[0].h;
  doc.strokes = doc.pages[0].strokes;
  return doc;
}

function inkPage() {
  const d = state.inkDoc;
  if (!d || !d.pages || !d.pages.length) return null;
  return d.pages[Math.max(0, Math.min(state.inkPage, d.pages.length - 1))];
}

function updateInkHead() {
  const d = state.inkDoc;
  if (!d) return;
  const pg = inkPage();
  const total = d.pages.length;
  $("ink-hint").textContent = `${total} 页 · 本页 ${pg ? pg.strokes.length : 0} 笔`;
  $("ink-page").textContent = `${state.inkPage + 1} / ${total}`;
}

async function openInk(meta) {
  $("editor").classList.add("hidden");
  $("inkview").classList.remove("hidden");
  $("ink-title").textContent = meta.title || "手写笔记";

  let doc = null;
  try {
    doc = await readJson(`${meta.id}.ink`);
  } catch (e) {
    doc = null;
  }
  state.inkDoc = normInkDoc(doc);
  state.inkPage = 0;
  updateInkHead();
  // 等布局完成后再取 canvas 尺寸，否则 clientWidth 还是 0，缩放会算错
  requestAnimationFrame(() => {
    fitView();
    renderInk();
  });
}

function closeEditors() {
  state.active = null;
  state.inkDoc = null;
  $("editor").classList.add("hidden");
  $("inkview").classList.add("hidden");
  $("empty").classList.remove("hidden");
  renderList();
}

// ---------------- 文字保存 ----------------

async function saveText() {
  const id = state.active;
  if (!id) return;
  const meta = state.notes.find(n => n.id === id);
  let base = meta || { id: id, type: 0 };
  try {
    const cur = await readJson(`${id}.json`);
    if (cur) base = cur;
  } catch (e) { /* 用元数据兜底 */ }

  // 把界面上正在编辑的那一页同步进数组
  if (state.textPages.length > 0) {
    state.textPages[state.textPage] = $("ed-content").value;
  }
  const note = {
    id: id,
    type: 0,
    title: $("ed-title").value.trim() || "未命名",
    content: state.textPages[0] || "",
    pages: state.textPages.slice(),
    inkPath: "",
    updatedAt: Date.now(),
    deviceId: "windows-pc",
    version: (base.version || 0) + 1,
    deleted: false,
    group: base.group || "",
    history: base.history || []
  };
  pushHist(note, "edit", note.title);
  try {
    await writeJson(`${id}.json`, note);
    $("ed-meta").textContent = `已保存 · v${note.version} · ${fmt(note.updatedAt)}`;
    await scanNotes();
  } catch (e) {
    $("ed-meta").textContent = `保存失败：${e.message}（Windows 文件服务可能未启动）`;
  }
}

// ---------------- 手写板 ----------------

let drawing = false;
let curStroke = null;
let lastPt = null;

/** 整页等比适配到可视区：按页面自身尺寸缩放，手机/电脑不同画布都能完整显示 */
function fitView() {
  const cv = $("ink-canvas");
  const w = cv.clientWidth || 800;
  const h = cv.clientHeight || 600;
  const pg = inkPage();
  if (!pg) {
    state.view = { s: 1, ox: 0, oy: 0 };
    return;
  }
  const pad = 18;
  let s = Math.min((w - pad * 2) / pg.w, (h - pad * 2) / pg.h);
  s = Math.max(0.05, Math.min(s, 4));
  state.view = {
    s: s,
    ox: (w - pg.w * s) / 2,
    oy: (h - pg.h * s) / 2
  };
}

function renderInk() {
  const cv = $("ink-canvas");
  const ctx = cv.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth || 1;
  const h = cv.clientHeight || 1;

  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = "#e6eaf2";
  ctx.fillRect(0, 0, w, h);

  const pg = inkPage();
  if (!pg) return;
  const v = state.view;
  ctx.save();
  ctx.translate(v.ox, v.oy);
  ctx.scale(v.s, v.s);

  // 纸张 + 边框
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, pg.w, pg.h);
  ctx.strokeStyle = "#d5dbe6";
  ctx.lineWidth = 1 / v.s;
  ctx.strokeRect(0, 0, pg.w, pg.h);

  for (const st of pg.strokes) drawStroke(ctx, st);
  ctx.restore();
}

function drawStroke(ctx, s) {
  const pts = s.points || [];
  if (pts.length === 0) return;
  ctx.strokeStyle = s.color || "#1a1a1a";
  ctx.lineWidth = s.width || 3;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  if (pts.length === 1) ctx.lineTo(pts[0][0] + 0.5, pts[0][1] + 0.5);
  ctx.stroke();
}

function toDoc(e) {
  const cv = $("ink-canvas");
  const r = cv.getBoundingClientRect();
  const v = state.view;
  return [
    (e.clientX - r.left - v.ox) / v.s,
    (e.clientY - r.top - v.oy) / v.s,
    e.pressure || 1,
    Date.now()
  ];
}

function bindInk() {
  const cv = $("ink-canvas");

  cv.addEventListener("pointerdown", (e) => {
    const pg = inkPage();
    if (!pg) return;
    const p = toDoc(e);
    // 页面外（灰色留白）不落笔
    if (p[0] < 0 || p[1] < 0 || p[0] > pg.w || p[1] > pg.h) return;
    drawing = true;
    cv.setPointerCapture(e.pointerId);
    const w = (e.pointerType === "pen" ? 2.5 : 4) / Math.max(state.view.s, 0.05);
    curStroke = { color: "#1a1a1a", width: w, points: [p] };
    pg.strokes.push(curStroke);
    lastPt = p;
  });

  cv.addEventListener("pointermove", (e) => {
    const pg = inkPage();
    if (!drawing || !curStroke || !pg) return;
    const p = toDoc(e);
    p[0] = Math.max(0, Math.min(p[0], pg.w));
    p[1] = Math.max(0, Math.min(p[1], pg.h));
    curStroke.points.push(p);

    // 只绘制增量线段，避免每次全量重绘
    const ctx = cv.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    const v = state.view;
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.translate(v.ox, v.oy);
    ctx.scale(v.s, v.s);
    ctx.strokeStyle = curStroke.color;
    ctx.lineWidth = curStroke.width;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(lastPt[0], lastPt[1]);
    ctx.lineTo(p[0], p[1]);
    ctx.stroke();
    ctx.restore();

    lastPt = p;
  });

  const finish = async () => {
    if (!drawing) return;
    drawing = false;
    curStroke = null;
    lastPt = null;
    updateInkHead();
    await persistInk();
  };
  cv.addEventListener("pointerup", finish);
  cv.addEventListener("pointercancel", finish);
}

async function persistInk() {
  const id = state.active;
  if (!id || !state.inkDoc) return;
  const meta = state.notes.find(n => n.id === id);
  try {
    // 先同步第 1 页镜像字段，旧版本客户端也能看到首页
    state.inkDoc.version = 2;
    state.inkDoc.canvasW = state.inkDoc.pages[0].w;
    state.inkDoc.canvasH = state.inkDoc.pages[0].h;
    state.inkDoc.strokes = state.inkDoc.pages[0].strokes;
    await writeJson(`${id}.ink`, state.inkDoc);
    const note = {
      id: id,
      type: 1,
      title: meta ? (meta.title || "手写笔记") : "手写笔记",
      content: "",
      inkPath: `${id}.ink`,
      updatedAt: Date.now(),
      deviceId: "windows-pc",
      version: ((meta && meta.version) || 0) + 1,
      deleted: false,
      group: (meta && meta.group) || "",
      history: (meta && meta.history) || []
    };
    pushHist(note, "edit", note.title);
    await writeJson(`${id}.json`, note);
    await scanNotes();
  } catch (e) {
    $("ink-hint").textContent = "保存失败：" + e.message;
  }
}

/** 切换手写页码：切页后重新适配并重绘 */
function gotoInkPage(i) {
  const d = state.inkDoc;
  if (!d) return;
  state.inkPage = Math.max(0, Math.min(i, d.pages.length - 1));
  updateInkHead();
  fitView();
  renderInk();
}

function addInkPage() {
  const d = state.inkDoc;
  if (!d) return;
  const cur = inkPage();
  d.pages.push({ w: cur.w, h: cur.h, strokes: [] });
  state.inkPage = d.pages.length - 1;
  updateInkHead();
  fitView();
  renderInk();
  persistInk();
}

function setupInkTools() {
  document.querySelectorAll(".ink-tools button").forEach(b => {
    b.onclick = async () => {
      const act = b.dataset.act;
      if (!state.inkDoc) return;
      const pg = inkPage();

      if (act === "prev") {
        gotoInkPage(state.inkPage - 1);
      } else if (act === "next") {
        gotoInkPage(state.inkPage + 1);
      } else if (act === "add") {
        addInkPage();
      } else if (act === "undo") {
        if (!pg) return;
        pg.strokes.pop();
        renderInk();
        updateInkHead();
        await persistInk();
      } else if (act === "erase-all") {
        openModal("清空本页", `将删除第 ${state.inkPage + 1} 页的全部笔迹，不可撤销。`, null, async () => {
          if (!pg) return;
          pg.strokes = [];
          renderInk();
          updateInkHead();
          await persistInk();
        }, true);
      } else if (act === "fit") {
        fitView();
        renderInk();
      }
    };
  });
}

// ---------------- 管理菜单 ----------------

function showMenu(id, anchor) {
  const n = state.notes.find(x => x.id === id);
  if (!n) return;
  state.menuId = id;

  const items = n.deleted
    ? [["restore", "↩ 恢复"], ["rename", "✎ 重命名"], ["purge", "🗑 彻底删除", "danger"]]
    : [["move", "📁 移动到分组"], ["copy", "⧉ 复制到分组"], ["rename", "✎ 重命名"],
       ["trash", "🗑 移入回收站", "danger"]];

  const m = $("menu");
  m.innerHTML = "";
  for (const [act, label, cls] of items) {
    const b = document.createElement("button");
    b.textContent = label;
    if (cls) b.className = cls;
    b.onclick = () => {
      if (act === "move" || act === "copy") {
        // 二级菜单选目标组，避免直接弹出输入框打断操作
        showGroupMenu(id, act, anchor);
      } else {
        hideMenu();
        doAction(act, id);
      }
    };
    m.appendChild(b);
  }

  m.classList.remove("hidden");
  const r = anchor.getBoundingClientRect();
  const mw = m.offsetWidth || 150;
  const mh = m.offsetHeight || 90;
  m.style.left = Math.max(8, Math.min(r.left - mw + 28, window.innerWidth - mw - 8)) + "px";
  m.style.top = Math.max(8, Math.min(r.bottom + 4, window.innerHeight - mh - 8)) + "px";
}

/** 组选择二级菜单：列出现有组 + 新建组输入 */
function showGroupMenu(id, mode, anchor) {
  const m = $("menu");
  m.innerHTML = "";
  const mk = (label, fn, cls) => {
    const b = document.createElement("button");
    b.textContent = label;
    if (cls) b.className = cls;
    b.onclick = () => { hideMenu(); fn(); };
    m.appendChild(b);
  };
  mk(mode === "copy" ? "⧉ 复制到「未分组」" : "📁 移到「未分组」",
    () => doAction(mode, id, ""));
  for (const g of state.groups) {
    mk(mode === "copy" ? `⧉ 复制到「${g}」` : `📁 移到「${g}」`, () => doAction(mode, id, g));
  }
  mk("＋ 新组名…", () => {
    openModal(mode === "copy" ? "复制到新分组" : "移动到新分组", "输入分组名称", "",
      async (val) => {
        const g = (val || "").trim();
        if (!g) throw new Error("分组名不能为空");
        await doAction(mode, id, g);
      });
  });

  m.classList.remove("hidden");
  const r = anchor.getBoundingClientRect();
  const mw = m.offsetWidth || 170;
  const mh = m.offsetHeight || 90;
  m.style.left = Math.max(8, Math.min(r.left - mw + 28, window.innerWidth - mw - 8)) + "px";
  m.style.top = Math.max(8, Math.min(r.bottom + 4, window.innerHeight - mh - 8)) + "px";
}

function hideMenu() {
  $("menu").classList.add("hidden");
  state.menuId = null;
}

/** 读-改-写一条笔记；带 act/detail 时同步写操作记录 */
async function patchNote(id, fn, act, detail) {
  let note = null;
  try {
    note = await readJson(`${id}.json`);
  } catch (e) {
    note = state.notes.find(x => x.id === id) || null;
  }
  if (!note) return;
  fn(note);
  note.updatedAt = Date.now();
  note.deviceId = "windows-pc";
  note.version = (note.version || 1) + 1;
  if (act) pushHist(note, act, detail || note.title || "未命名");
  await writeJson(`${id}.json`, note);
}

async function doAction(act, id, group) {
  const n = state.notes.find(x => x.id === id);
  if (!n) return;
  const title = n.title || "未命名";

  if (act === "rename") {
    openModal("重命名", "输入新的标题", title, async (val) => {
      const t = (val || "").trim();
      if (!t) throw new Error("标题不能为空");
      await patchNote(id, (note) => { note.title = t; }, "edit", `重命名为「${t}」`);
      if (state.active === id) {
        if (n.type === 0) $("ed-title").value = t;
        else $("ink-title").textContent = t;
      }
    });
    return;
  }

  if (act === "move") {
    const from = n.group || "未分组";
    await patchNote(id, (note) => { note.group = group || ""; }, "move",
      group ? `从「${from}」移动到「${group}」` : `从「${from}」移出分组`);
    if (group) {
      const gs = await readGroupsFile();
      if (gs.indexOf(group) < 0) {
        gs.push(group);
        await writeGroupsFile(gs);
      }
    }
    await loadGroups();
    return;
  }

  if (act === "copy") {
    const nid = uuid();
    let src = null;
    try { src = await readJson(`${id}.json`); } catch (e) { src = null; }
    if (!src) src = n;
    const cp = Object.assign({}, src);
    cp.id = nid;
    cp.title = `${src.title} 副本`;
    cp.group = group || "";
    cp.updatedAt = Date.now();
    cp.deviceId = "windows-pc";
    cp.version = 1;
    cp.deleted = false;
    cp.history = [];
    await writeJson(`${nid}.json`, cp);
    pushHist(cp, "copy", group ? `复制自「${title}」到「${group}」` : `复制自「${title}」`);
    await writeJson(`${nid}.json`, cp);
    if (src.type === 1) {
      try {
        const ink = await readJson(`${id}.ink`);
        await writeJson(`${nid}.ink`, ink);
      } catch (e) { /* 没有笔迹文件就算了 */ }
    }
    if (group) {
      const gs = await readGroupsFile();
      if (gs.indexOf(group) < 0) {
        gs.push(group);
        await writeGroupsFile(gs);
      }
    }
    await loadGroups();
    return;
  }

  if (act === "trash") {
    openModal("移入回收站", `「${title}」将进入回收站，可随时恢复。`, null, async () => {
      await patchNote(id, (note) => { note.deleted = true; }, "trash", "移入回收站");
      if (state.active === id) closeEditors();
    }, true);
    return;
  }

  if (act === "restore") {
    openModal("恢复笔记", `「${title}」将回到笔记列表。`, null, async () => {
      await patchNote(id, (note) => { note.deleted = false; }, "restore", "从回收站恢复");
      switchView("notes");
    });
    return;
  }

  if (act === "purge") {
    openModal("彻底删除", "删除后无法恢复，手机端下次同步也会删掉这份副本。确定吗？", null, async () => {
      await appendGlobalLog({ t: Date.now(), act: "purge", detail: `彻底删除「${title}」`, dev: "windows-pc" });
      await deleteRemote(`${id}.json`);
      if (n.type === 1) await deleteRemote(`${id}.ink`);
      if (state.active === id) closeEditors();
    }, true);
  }
}

// ---------------- 模态框 ----------------

function openModal(title, msg, inputVal, ok, danger) {
  $("mo-title").textContent = title;
  $("mo-msg").textContent = msg;

  const inp = $("mo-input");
  state.modalHasInput = inputVal !== null;
  if (state.modalHasInput) {
    inp.classList.remove("hidden");
    inp.value = inputVal;
  } else {
    inp.classList.add("hidden");
    inp.value = "";
  }
  $("mo-ok").className = danger ? "danger" : "primary";
  state.modalOk = ok;

  $("modal").classList.remove("hidden");
  if (state.modalHasInput) {
    setTimeout(() => { inp.focus(); inp.select(); }, 40);
  }
}

function closeModal() {
  $("modal").classList.add("hidden");
  state.modalOk = null;
  state.modalHasInput = false;
}

// ---------------- UI 绑定 ----------------

function switchView(tab) {
  state.tab = tab;
  if (tab !== "notes") {
    state.batch = false;
    state.sel = [];
  }
  $("tab-notes").classList.toggle("active", tab === "notes");
  $("tab-groups").classList.toggle("active", tab === "groups");
  $("tab-history").classList.toggle("active", tab === "history");
  $("tab-trash").classList.toggle("active", tab === "trash");
  $("btn-purge-all").classList.toggle("hidden", tab !== "trash");
  $("batch-bar").classList.toggle("hidden", tab !== "notes");
  $("btn-batch-del").classList.add("hidden");
  if (tab !== "history") {
    closeEditors();
    $("empty").classList.toggle("hidden", false);
  }
  renderList();
}

async function batchDelete() {
  const ids = state.sel.slice(0);
  if (ids.length === 0) return;
  openModal("批量删除", `选中的 ${ids.length} 条笔记将移入回收站（可在回收站恢复），并同步到手机。`, null, async () => {
    for (const id of ids) {
      await patchNote(id, (note) => { note.deleted = true; }, "trash", "移入回收站");
    }
    state.sel = [];
    state.batch = false;
    $("btn-batch").textContent = "☑ 多选";
  }, true);
}

function bindUI() {
  $("tab-notes").onclick = () => switchView("notes");
  $("tab-groups").onclick = () => switchView("groups");
  $("tab-history").onclick = () => switchView("history");
  $("tab-trash").onclick = () => switchView("trash");

  $("btn-batch").onclick = () => {
    state.batch = !state.batch;
    state.sel = [];
    $("btn-batch").textContent = state.batch ? "退出多选" : "☑ 多选";
    $("btn-batch-del").classList.add("hidden");
    renderList();
  };
  $("btn-batch-del").onclick = batchDelete;

  $("btn-new-text").onclick = async () => {
    const id = uuid();
    try {
      await writeJson(`${id}.json`, {
        id: id, type: 0, title: "新建笔记", content: "", inkPath: "",
        updatedAt: Date.now(), deviceId: "windows-pc", version: 1, deleted: false,
        group: "", history: [{ t: Date.now(), act: "create", detail: "新建「新建笔记」", dev: "windows-pc" }]
      });
      await scanNotes();
      await openNote(id);
      $("ed-title").focus();
      $("ed-title").select();
    } catch (e) {
      alert("新建失败：" + e.message);
    }
  };

  $("btn-new-ink").onclick = async () => {
    const id = uuid();
    try {
      const page = { w: 900, h: 1200, strokes: [] };
      await writeJson(`${id}.ink`, {
        format: "harmonynote-ink", version: 2,
        canvasW: page.w, canvasH: page.h, strokes: [],
        pages: [page]
      });
      await writeJson(`${id}.json`, {
        id: id, type: 1, title: "手写笔记", content: "", inkPath: `${id}.ink`,
        updatedAt: Date.now(), deviceId: "windows-pc", version: 1, deleted: false,
        group: "", history: [{ t: Date.now(), act: "create", detail: "新建「手写笔记」", dev: "windows-pc" }]
      });
      await scanNotes();
      await openNote(id);
    } catch (e) {
      alert("新建失败：" + e.message);
    }
  };

  $("btn-purge-all").onclick = () => {
    openModal("清空回收站", "回收站里的全部笔记将被彻底删除，且同步到手机端。此操作不可恢复。", null, async () => {
      try {
        await window.__TAURI__.core.invoke("purge_trash");
      } catch (e) {
        alert("清空失败：" + e.message);
      }
      closeEditors();
    }, true);
  };

  $("btn-open-dir").onclick = async () => {
    try {
      const dir = await window.__TAURI__.core.invoke("notes_dir");
      await window.__TAURI__.core.invoke("open_notes_dir", { dir: dir });
    } catch (e) {
      alert("打开目录失败：" + e.message);
    }
  };

  $("btn-firewall").onclick = async () => {
    try {
      const done = await requestFirewall();
      if (done) {
        openModal("已放行", "防火墙规则已添加，手机现在可以连上这台电脑了。", null, null, false);
      } else {
        openModal("尚未放行",
          "若刚才点了「否」，可以再试一次；若当前账号没有管理员权限，" +
          "请右键以管理员身份运行本程序后再点「防火墙放行」。",
          null, null, false);
      }
    } catch (e) {
      openModal("无法执行", "当前环境不支持自动放行，请手动在 Windows 防火墙中允许本程序。", null, null, false);
    }
  };

  $("ed-save").onclick = saveText;

  $("mo-ok").onclick = async () => {
    const fn = state.modalOk;
    const val = state.modalHasInput ? $("mo-input").value : null;
    closeModal();
    if (fn) {
      try {
        await fn(val);
      } catch (e) {
        alert("操作失败：" + (e && e.message ? e.message : e));
      }
    }
    await scanNotes();
  };
  $("mo-cancel").onclick = closeModal;
  $("modal").onclick = (e) => { if (e.target === $("modal")) closeModal(); };

  $("mo-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("mo-ok").click();
    if (e.key === "Escape") closeModal();
  });

  document.addEventListener("click", (e) => {
    if (!$("menu").classList.contains("hidden") && !$("menu").contains(e.target)) hideMenu();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { hideMenu(); closeModal(); }
  });

  window.addEventListener("resize", () => {
    if (!state.inkDoc || $("inkview").classList.contains("hidden")) return;
    fitView();
    renderInk();
  });

  setupInkTools();
  bindInk();
}

// ---------------- 初始化 ----------------

let serverAddr = "127.0.0.1:8787";

function fmtAgo(ts) {
  if (!ts) return "";
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return "刚刚";
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return `${Math.floor(s / 86400)} 天前`;
}

// 电脑端是被动接收方：这里显示本机地址，以及手机上次连入的时间。
// 手机每次同步都会先请求 /api/notes，后端会把时间戳写到 _last_pull。
async function refreshServerInfo() {
  try {
    const info = await window.__TAURI__.core.invoke("server_info");
    if (info && info.bound === false) {
      $("srv-info").textContent = `端口 ${info.port} 被占用`;
      return;
    }
    serverAddr = `${info.ip || "127.0.0.1"}:${info.port || 8787}`;
    $("srv-info").textContent = serverAddr;
    const line = $("sync-line");
    if (line) {
      line.textContent = info.lastPull
        ? `手机上次同步：${fmtAgo(info.lastPull)}`
        : "手机尚未连接过 · 在手机端点「同步」";
    }
  } catch (e) {
    $("srv-info").textContent = "127.0.0.1:8787";
  }
}

// ---------------- 防火墙放行 ----------------

/** 触发 UAC 添加放行规则；返回是否真的添加成功 */
async function requestFirewall() {
  return await window.__TAURI__.core.invoke("open_firewall");
}

/** 启动时静默检查：没有规则才提示，避免每次打开都弹窗 */
async function ensureFirewall() {
  try {
    const ok = await window.__TAURI__.core.invoke("firewall_status");
    if (ok) return;
    openModal("允许手机连接本机",
      "手机同步笔记需要允许本程序通过 Windows 防火墙（TCP 8787）。" +
      "点击「确定」后，请在系统弹窗中选择「是」。选择「否」手机将无法连接这台电脑，" +
      "可稍后用左下角「防火墙放行」重试。",
      null,
      async () => {
        const done = await requestFirewall();
        if (!done) {
          openModal("尚未放行",
            "系统没有完成放行：可能点了「否」，或当前账号没有管理员权限。" +
            "可右键以管理员身份运行后，再点「防火墙放行」重试。",
            null, null, false);
        }
      });
  } catch (e) {
    // 非 Windows 或旧版本没有该命令，忽略
  }
}

async function copyAddr() {
  const btn = $("btn-copy-addr");
  let ok = false;
  try {
    await navigator.clipboard.writeText(serverAddr);
    ok = true;
  } catch (e) { /* 回退到 execCommand */ }
  if (!ok) {
    const ta = document.createElement("textarea");
    ta.value = serverAddr;
    document.body.appendChild(ta);
    ta.select();
    try { ok = document.execCommand("copy"); } catch (e2) { /* 忽略 */ }
    ta.remove();
  }
  btn.textContent = ok ? "已复制" : "复制失败";
  setTimeout(() => { btn.textContent = "复制地址"; }, 1500);
}

(async function init() {
  try {
    if (!window.__TAURI__) {
      $("srv-info").textContent = "Tauri API 未启用";
      return;
    }
    state.dir = await window.__TAURI__.core.invoke("notes_dir");
    $("dir-info").textContent = state.dir;

    await refreshServerInfo();
    setInterval(refreshServerInfo, 5000);
    $("btn-copy-addr").addEventListener("click", copyAddr);

    bindUI();
    // 安装包已通过 NSIS 钩子放行；万一被拦截/绿色版运行，这里会弹一次提示。
    ensureFirewall();
    await scanNotes();
    setInterval(scanNotes, 3000);
  } catch (e) {
    $("srv-info").textContent = "初始化失败：" + (e && e.message ? e.message : e);
  }
})();
