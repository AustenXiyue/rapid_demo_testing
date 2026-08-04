"use strict";

/* ================= 地图配置 =================
 * 18 格环形地图,索引 0..17,顺时针前进。
 * 0 = START(S),5/12 = 工坊,2/8/14/17 = 星星候选位。
 * (规则 PDF 第 6 页 9~12 号格被示意图遮挡,此处按对称原则
 *  假设 12 号为第二个工坊,可在下方常量中随意调整。)
 */
const MAP_SIZE = 18;
const WORKSHOPS = [5, 12];
const CANDIDATES = [2, 8, 14, 17];

const COST_BUY_D4 = 6;
const COST_UP_D6 = 4;
const COST_UP_D8 = 7;
const COST_STAR = 8;

const PLAYER_COLORS = ["#2f7fd6", "#3e9c7d", "#e0862e", "#8d5fd3", "#d34f9c", "#2fa8b8"];

/* ================= 全局状态 ================= */
let S = null; // 游戏状态
let setupCfg = { count: 3, target: 3, names: [] };

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (n) => Math.floor(Math.random() * n);

/* ================= 设置界面 ================= */
function initSetup() {
  const countWrap = $("playerCountBtns");
  countWrap.innerHTML = "";
  for (let n = 1; n <= 6; n++) {
    const b = document.createElement("button");
    b.textContent = n;
    b.className = n === setupCfg.count ? "active" : "";
    b.onclick = () => { setupCfg.count = n; initSetup(); };
    countWrap.appendChild(b);
  }

  const nameWrap = $("nameInputs");
  nameWrap.innerHTML = "";
  for (let i = 0; i < setupCfg.count; i++) {
    const item = document.createElement("div");
    item.className = "name-item";
    const dot = document.createElement("i");
    dot.className = "dot";
    dot.style.background = PLAYER_COLORS[i];
    const input = document.createElement("input");
    input.value = setupCfg.names[i] || `玩家${i + 1}`;
    input.maxLength = 8;
    input.oninput = () => { setupCfg.names[i] = input.value; };
    item.appendChild(dot);
    item.appendChild(input);
    nameWrap.appendChild(item);
  }

  const targetWrap = $("targetStarBtns");
  targetWrap.innerHTML = "";
  for (let n = 1; n <= 5; n++) {
    const b = document.createElement("button");
    b.textContent = n;
    b.className = n === setupCfg.target ? "active" : "";
    b.onclick = () => { setupCfg.target = n; initSetup(); };
    targetWrap.appendChild(b);
  }
}

function newGame() {
  const players = [];
  for (let i = 0; i < setupCfg.count; i++) {
    players.push({
      id: i,
      name: (setupCfg.names[i] || `玩家${i + 1}`).trim() || `玩家${i + 1}`,
      color: PLAYER_COLORS[i],
      pos: 0,
      resources: 0,
      stars: 0,
      dice: [{ sides: 4 }, { sides: 4 }, { sides: 4 }],
      confirmed: false,
    });
  }
  S = {
    phase: "assign",
    round: 0,
    target: setupCfg.target,
    players,
    starPos: CANDIDATES[rand(CANDIDATES.length)],
    log: [],
  };
  $("log").innerHTML = "";
  $("setup").classList.add("hidden");
  $("game").classList.remove("hidden");
  addLog(`游戏开始!${players.length} 名玩家,先获得 <b class="hl-star">${S.target} 颗星星</b>者获胜。当前星星位于 <b>${cellName(S.starPos)}</b>。`);
  startRound();
}

/* ================= 回合流程 ================= */
function startRound() {
  S.round += 1;
  S.phase = "assign";
  for (const p of S.players) {
    p.confirmed = false;
    for (const d of p.dice) {
      d.value = 1 + rand(d.sides);
      d.slot = null;
    }
  }
  addLog(`<span class="rnd">—— 第 ${S.round} 轮 · 投骰 ——</span>`);
  for (const p of S.players) {
    addLog(`${pchip(p)}投出:${p.dice.map((d) => `D${d.sides}=${d.value}`).join("、")}`);
  }
  render();
}

function cycleDie(pi, di) {
  if (S.phase !== "assign") return;
  const p = S.players[pi];
  if (p.confirmed) return;
  const die = p.dice[di];
  const moveTaken = p.dice.some((d, j) => j !== di && d.slot === "move");
  const resTaken = p.dice.some((d, j) => j !== di && d.slot === "res");

  if (die.slot === null) {
    if (!moveTaken) die.slot = "move";
    else if (!resTaken) die.slot = "res";
  } else if (die.slot === "move") {
    die.slot = resTaken ? null : "res";
  } else {
    die.slot = null;
  }
  render();
}

function confirmPlayer(pi) {
  const p = S.players[pi];
  if (p.confirmed) { p.confirmed = false; render(); return; }
  const hasMove = p.dice.some((d) => d.slot === "move");
  const hasRes = p.dice.some((d) => d.slot === "res");
  if (!hasMove || !hasRes) return;
  p.confirmed = true;
  render();
  if (S.players.every((x) => x.confirmed)) resolveRound();
}

async function resolveRound() {
  S.phase = "resolve";
  render();
  addLog(`<span class="rnd">—— 第 ${S.round} 轮 · 公开并结算 ——</span>`);
  await sleep(700);

  // 1) 先得资源(所有玩家)
  for (const p of S.players) {
    const r = p.dice.find((d) => d.slot === "res").value;
    p.resources += r;
    addLog(`${pchip(p)}资源槽 ${r} → 获得 <span class="hl-res">${r} 资源</span>(现有 ${p.resources})`);
  }
  render();
  await sleep(500);

  // 2) 严格移动(逐个玩家动画)
  for (const p of S.players) {
    const m = p.dice.find((d) => d.slot === "move").value;
    for (let s = 0; s < m; s++) {
      p.pos = (p.pos + 1) % MAP_SIZE;
      renderBoard();
      await sleep(180);
    }
    addLog(`${pchip(p)}移动槽 ${m} → 前进 ${m} 格,停在 <b>${cellName(p.pos)}</b>${landDesc(p.pos)}`);
    await sleep(220);
  }

  // 3) 落点结算(工坊 / 当前星星)
  let starBought = false;
  for (const p of S.players) {
    if (WORKSHOPS.includes(p.pos)) {
      await workshopDecision(p);
    } else if (p.pos === S.starPos) {
      const bought = await starDecision(p);
      if (bought) starBought = true;
    }
    render();
  }

  // 4) 轮末:移星 + 检查胜利
  if (starBought) {
    const options = CANDIDATES.filter((c) => c !== S.starPos);
    S.starPos = options[rand(options.length)];
    addLog(`当前星星被购买,随机移动到 <b class="hl-star">${cellName(S.starPos)}</b>。`);
  }
  render();

  const winners = S.players.filter((p) => p.stars >= S.target);
  if (winners.length > 0) {
    S.phase = "gameover";
    render();
    await showModal({
      title: "🎉 游戏结束",
      body: winners.length === 1
        ? `<b>${winners[0].name}</b> 率先获得 ${S.target} 颗星星,获得胜利!(共 ${S.round} 轮)`
        : `${winners.map((w) => `<b>${w.name}</b>`).join("、")} 在同一轮达成 ${S.target} 颗星星,共享胜利!(共 ${S.round} 轮)`,
      buttons: [{ label: "再来一局", accent: true, value: 1 }],
    });
    $("game").classList.add("hidden");
    $("setup").classList.remove("hidden");
    initSetup();
    return;
  }

  await sleep(400);
  startRound();
}

/* ---------- 工坊决策 ---------- */
async function workshopDecision(p) {
  const hasD4 = p.dice.some((d) => d.sides === 4);
  const hasD6 = p.dice.some((d) => d.sides === 6);
  const choice = await showModal({
    title: `🔧 ${p.name} 停在工坊`,
    body: `当前资源:<b>${p.resources}</b> · 骰池:${poolText(p)}<br>可选择 1 次成长操作(也可以不操作,资源不会丢失):`,
    buttons: [
      { label: "购买 1 颗 D4", cost: `−${COST_BUY_D4} 资源`, value: "buy", disabled: p.resources < COST_BUY_D4 },
      { label: "升级 D4 → D6", cost: `−${COST_UP_D6} 资源`, value: "up6", disabled: p.resources < COST_UP_D6 || !hasD4 },
      { label: "升级 D6 → D8", cost: `−${COST_UP_D8} 资源`, value: "up8", disabled: p.resources < COST_UP_D8 || !hasD6 },
      { label: "不操作", value: "skip" },
    ],
  });
  if (choice === "buy") {
    p.resources -= COST_BUY_D4;
    p.dice.push({ sides: 4, value: null, slot: null });
    addLog(`${pchip(p)}在工坊花 ${COST_BUY_D4} 资源<b>购买 1 颗 D4</b>(剩 ${p.resources} 资源,下轮生效)`);
  } else if (choice === "up6") {
    p.resources -= COST_UP_D6;
    p.dice.find((d) => d.sides === 4).sides = 6;
    addLog(`${pchip(p)}在工坊花 ${COST_UP_D6} 资源<b>升级 D4→D6</b>(剩 ${p.resources} 资源,下轮生效)`);
  } else if (choice === "up8") {
    p.resources -= COST_UP_D8;
    p.dice.find((d) => d.sides === 6).sides = 8;
    addLog(`${pchip(p)}在工坊花 ${COST_UP_D8} 资源<b>升级 D6→D8</b>(剩 ${p.resources} 资源,下轮生效)`);
  } else {
    addLog(`${pchip(p)}在工坊选择不操作。`);
  }
}

/* ---------- 星星决策 ---------- */
async function starDecision(p) {
  if (p.resources < COST_STAR) {
    addLog(`${pchip(p)}停在当前星星,但资源不足 ${COST_STAR},无法购买。`);
    return false;
  }
  const choice = await showModal({
    title: `⭐ ${p.name} 停在当前星星`,
    body: `当前资源:<b>${p.resources}</b> · 已有星星:<b>${p.stars}/${S.target}</b><br>是否支付 ${COST_STAR} 资源购买 1 颗星星?`,
    buttons: [
      { label: "购买星星", cost: `−${COST_STAR} 资源`, value: "buy", accent: true },
      { label: "放弃(星星留在原地)", value: "skip" },
    ],
  });
  if (choice === "buy") {
    p.resources -= COST_STAR;
    p.stars += 1;
    addLog(`${pchip(p)}支付 ${COST_STAR} 资源,<span class="hl-star">获得 1 颗星星!(${p.stars}/${S.target})</span>`);
    return true;
  }
  addLog(`${pchip(p)}选择不购买星星。`);
  return false;
}

/* ================= 渲染 ================= */
function render() {
  $("roundInfo").textContent = S.phase === "gameover" ? `第 ${S.round} 轮 · 已结束` : `第 ${S.round} 轮`;
  $("phaseHint").textContent =
    S.phase === "assign"
      ? "分配阶段:每人点击骰子放入槽位(再点切换),两个槽都放好后按「确认」。全部确认后自动结算。"
      : S.phase === "resolve"
      ? "结算中:先得资源 → 严格移动 → 落点结算……"
      : "游戏结束";
  renderBoard();
  renderPanels();
}

function cellName(i) {
  return i === 0 ? "S(START)" : `${i} 号格`;
}
function cellLabel(i) {
  return i === 0 ? "S" : String(i);
}
function landDesc(pos) {
  if (WORKSHOPS.includes(pos)) return "(工坊)";
  if (pos === S.starPos) return "(当前星星!)";
  if (CANDIDATES.includes(pos)) return "(候选位)";
  return "";
}
function poolText(p) {
  const c = { 4: 0, 6: 0, 8: 0 };
  p.dice.forEach((d) => c[d.sides]++);
  return [4, 6, 8].filter((s) => c[s]).map((s) => `D${s}×${c[s]}`).join(" ");
}
function pchip(p) {
  return `<i class="pdot" style="background:${p.color}"></i><b>${p.name}</b> `;
}

/* ---------- 棋盘(SVG) ---------- */
function cellXY(i) {
  const angle = ((-90 + i * (360 / MAP_SIZE)) * Math.PI) / 180;
  return [360 + 295 * Math.cos(angle), 360 + 295 * Math.sin(angle)];
}

function renderBoard() {
  const svg = $("board");
  let html = "";

  // 底环
  html += `<circle cx="360" cy="360" r="295" fill="none" stroke="#e6dfd0" stroke-width="14"/>`;

  // 顺时针方向箭头
  html += `<g fill="#c9c0ad"><path d="M 512 96 l 22 14 -26 8 z"/></g>`;

  // 格子
  for (let i = 0; i < MAP_SIZE; i++) {
    const [x, y] = cellXY(i);
    const isStart = i === 0;
    const isWork = WORKSHOPS.includes(i);
    const isCand = CANDIDATES.includes(i);
    const isStar = i === S.starPos;

    let fill = "#ffffff", stroke = "#c9c0ad", dash = "";
    if (isStart) { fill = "#d3ece3"; stroke = "#3e9c7d"; }
    if (isWork) { fill = "#f7e6b3"; stroke = "#e0a72e"; }
    if (isCand) { fill = "#f8d9d9"; stroke = "#e05252"; dash = `stroke-dasharray="5 4"`; }
    if (isStar) { fill = "#fbeaea"; stroke = "#e05252"; dash = ""; }

    html += `<circle cx="${x}" cy="${y}" r="27" fill="${fill}" stroke="${stroke}" stroke-width="3" ${dash}/>`;

    if (isStar) {
      html += `<text x="${x}" y="${y + 2}" text-anchor="middle" dominant-baseline="middle" font-size="26" fill="#e05252">★</text>`;
      html += `<text x="${x}" y="${y + 42}" text-anchor="middle" font-size="12" fill="#8a8578" font-weight="700">${cellLabel(i)}</text>`;
    } else if (isWork) {
      html += `<text x="${x}" y="${y + 1}" text-anchor="middle" dominant-baseline="middle" font-size="17" fill="#9a6f0f" font-weight="800">工</text>`;
      html += `<text x="${x}" y="${y + 42}" text-anchor="middle" font-size="12" fill="#8a8578" font-weight="700">${cellLabel(i)}</text>`;
    } else {
      const color = isStart ? "#3e9c7d" : isCand ? "#e05252" : "#5c6672";
      html += `<text x="${x}" y="${y + 1}" text-anchor="middle" dominant-baseline="middle" font-size="16" fill="${color}" font-weight="800">${cellLabel(i)}</text>`;
    }
  }

  // 未确认玩家的移动落点预览(虚线圈)
  if (S.phase === "assign") {
    for (const p of S.players) {
      if (p.confirmed) continue;
      const md = p.dice.find((d) => d.slot === "move");
      if (!md) continue;
      const dest = (p.pos + md.value) % MAP_SIZE;
      const [x, y] = cellXY(dest);
      html += `<circle cx="${x}" cy="${y}" r="33" fill="none" stroke="${p.color}" stroke-width="2.5" stroke-dasharray="4 4" opacity="0.8"/>`;
    }
  }

  // 棋子(同格自动错开)
  const byCell = {};
  S.players.forEach((p) => { (byCell[p.pos] = byCell[p.pos] || []).push(p); });
  const offsets = [[0, 0], [-11, -9], [11, -9], [-11, 9], [11, 9], [0, -14]];
  for (const cell in byCell) {
    const [cx, cy] = cellXY(Number(cell));
    const ps = byCell[cell];
    ps.forEach((p, k) => {
      const off = ps.length === 1 ? [0, 0] : offsets[k % offsets.length];
      html += `<circle cx="${cx + off[0]}" cy="${cy + off[1]}" r="9" fill="${p.color}" stroke="#fff" stroke-width="2.5"/>`;
    });
  }

  // 中央信息
  html += `<text x="360" y="330" text-anchor="middle" font-size="30" font-weight="800" fill="#1c2733">第 ${S.round} 轮</text>`;
  html += `<text x="360" y="368" text-anchor="middle" font-size="15" fill="#8a8578">顺时针移动 · 星星在 ${cellLabel(S.starPos)} 号位</text>`;
  html += `<text x="360" y="400" text-anchor="middle" font-size="14" fill="#e05252" font-weight="700">目标:${S.target} 颗星星</text>`;

  svg.innerHTML = html;
}

/* ---------- 玩家面板 ---------- */
function renderPanels() {
  const wrap = $("panels");
  wrap.innerHTML = "";
  S.players.forEach((p, pi) => {
    const panel = document.createElement("div");
    panel.className = "panel" + (p.confirmed && S.phase === "assign" ? " confirmed" : "");

    const showAssign = S.phase !== "assign" || !p.confirmed; // 已确认后隐藏槽位选择(保留悬念)
    const moveDie = p.dice.find((d) => d.slot === "move");
    const resDie = p.dice.find((d) => d.slot === "res");

    let diceHtml = "";
    p.dice.forEach((d, di) => {
      const cls = ["die", `d${d.sides}`];
      if (showAssign && d.slot === "move") cls.push("slot-move");
      if (showAssign && d.slot === "res") cls.push("slot-res");
      if (S.phase !== "assign" || p.confirmed) cls.push("locked");
      const badge = showAssign && d.slot === "move" ? `<span class="badge">移</span>` : showAssign && d.slot === "res" ? `<span class="badge">资</span>` : "";
      diceHtml += `<div class="${cls.join(" ")}" onclick="cycleDie(${pi},${di})">${badge}<div class="val">${d.value ?? "-"}</div><div class="sides">D${d.sides}</div></div>`;
    });

    const slotsHtml = `
      <div class="slots-row">
        <div class="slot slot-move-box"><span>移动槽</span><span class="slot-val">${showAssign ? (moveDie ? moveDie.value : `<span class="empty">空</span>`) : "?"}</span></div>
        <div class="slot slot-res-box"><span>资源槽</span><span class="slot-val">${showAssign ? (resDie ? resDie.value : `<span class="empty">空</span>`) : "?"}</span></div>
      </div>`;

    let actionsHtml = "";
    if (S.phase === "assign") {
      actionsHtml = p.confirmed
        ? `<div class="panel-actions"><span class="waiting-note">✓ 已确认,等待其他玩家…</span><button class="confirm-btn undo" onclick="confirmPlayer(${pi})">改选</button></div>`
        : `<div class="panel-actions"><button class="confirm-btn" onclick="confirmPlayer(${pi})" ${moveDie && resDie ? "" : "disabled"}>确认选择</button></div>`;
    }

    panel.innerHTML = `
      <div class="panel-head">
        <i class="dot" style="background:${p.color}"></i>
        <b>${p.name}</b>
        <div class="panel-stats">
          <span class="stat-res">R ${p.resources}</span>
          <span class="stat-star">★ ${p.stars}/${S.target}</span>
        </div>
      </div>
      <div class="pool-line">位置:${cellName(p.pos)} · 骰池:${poolText(p)}</div>
      <div class="dice-row">${diceHtml}</div>
      ${slotsHtml}
      ${actionsHtml}`;
    wrap.appendChild(panel);
  });
}

/* ---------- 日志 ---------- */
function addLog(html) {
  S.log.push(html);
  const el = $("log");
  const div = document.createElement("div");
  div.innerHTML = html;
  el.appendChild(div);
  el.scrollTop = el.scrollHeight;
}

/* ---------- 弹窗 ---------- */
function showModal({ title, body, buttons }) {
  return new Promise((resolve) => {
    $("modalTitle").innerHTML = title;
    $("modalBody").innerHTML = body;
    const wrap = $("modalBtns");
    wrap.innerHTML = "";
    for (const btn of buttons) {
      const b = document.createElement("button");
      b.innerHTML = `<span>${btn.label}</span>` + (btn.cost ? `<span class="cost">${btn.cost}</span>` : "");
      if (btn.accent) b.classList.add("accent");
      if (btn.disabled) b.disabled = true;
      b.onclick = () => { $("modal").classList.add("hidden"); resolve(btn.value); };
      wrap.appendChild(b);
    }
    $("modal").classList.remove("hidden");
  });
}

/* ================= 入口 ================= */
window.cycleDie = cycleDie;
window.confirmPlayer = confirmPlayer;

$("startBtn").onclick = newGame;
$("resetBtn").onclick = () => {
  if (confirm("确定要放弃当前对局并重新开始吗?")) {
    $("game").classList.add("hidden");
    $("setup").classList.remove("hidden");
    $("log").innerHTML = "";
    initSetup();
  }
};
$("rulesBtn").onclick = () => $("rulesDrawer").classList.toggle("hidden");
$("rulesCloseBtn").onclick = () => $("rulesDrawer").classList.add("hidden");

initSetup();
