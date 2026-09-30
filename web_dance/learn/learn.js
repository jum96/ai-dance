/**
 * learn.js — 学舞模式的面板(只做 UI)。
 *
 * 这里不碰判定、音频、渲染:拆段逻辑在 sections.js,跑段的主循环在 main.js。
 * 面板只负责"选组 → 选部位 → 选速度 → 开始/停 → 显示每一遍的分数与纠正"。
 */
import { PART_GROUPS, partLabel } from "./sections.js";

const RATES = [
  { value: 0.5, label: "0.5x" },
  { value: 0.75, label: "0.75x" },
  { value: 1, label: "1x" },
];

const fmmss = (sec) => {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/** 纠正提示:最弱的部位 + 分档给一句人话 */
function fixText(worstId, score) {
  if (!worstId) return "";
  const label = partLabel(worstId);
  if (score == null) return `${label}看不清 —— 往镜头前站一点,让全身进画面`;
  if (score >= 0.85) return `${label}已经很稳了,可以提速或换下一组`;
  if (score >= 0.7) return `${label}还差一点 —— 再跟紧教练的手脚落点`;
  return `${label}差得最多 —— 降到 0.5x 看着教练再来一遍`;
}

export function createLearnPanel({ onPractice, onStop, onMerge, onExit }) {
  const root = document.getElementById("learn-root");
  if (!root) throw new Error("缺少 #learn-root 挂载点");

  root.innerHTML = `
    <section class="ln-panel">
      <header class="ln-head">
        <div>
          <div class="ln-title">学舞模式</div>
          <div class="ln-song" id="ln-song">—</div>
        </div>
        <button class="ln-x" id="ln-exit" type="button" aria-label="退出学舞">×</button>
      </header>

      <div class="ln-step">
        <div class="ln-label">1 · 选一组(自动切好的)</div>
        <div class="ln-chips" id="ln-sections"></div>
      </div>

      <div class="ln-step">
        <div class="ln-label">2 · 这一遍只练</div>
        <div class="ln-chips" id="ln-parts"></div>
      </div>

      <div class="ln-step">
        <div class="ln-label">3 · 速度</div>
        <div class="ln-chips" id="ln-rates"></div>
      </div>

      <div class="ln-actions">
        <button id="ln-start" class="ln-primary" type="button">开始这一组</button>
        <button id="ln-stop" type="button" disabled>停一下</button>
        <button id="ln-merge" type="button">串起来 · 整曲跑一遍</button>
      </div>

      <div class="ln-live hidden" id="ln-live">
        <div class="ln-hud">
          <span>第 <b id="ln-rep">1</b> 遍</span>
          <span>本遍 <b id="ln-score">0</b> 分</span>
          <span>最佳 <b id="ln-best">0</b> 分</span>
        </div>
        <div class="ln-bars" id="ln-bars"></div>
        <div class="ln-fix" id="ln-fix"></div>
      </div>

      <div class="ln-status" id="ln-status"></div>
    </section>`;

  const $ = (id) => root.querySelector(`#${id}`);
  const el = {
    song: $("ln-song"), sections: $("ln-sections"), parts: $("ln-parts"), rates: $("ln-rates"),
    start: $("ln-start"), stop: $("ln-stop"), merge: $("ln-merge"), exit: $("ln-exit"),
    live: $("ln-live"), rep: $("ln-rep"), score: $("ln-score"), best: $("ln-best"),
    bars: $("ln-bars"), fix: $("ln-fix"), status: $("ln-status"),
  };

  const selection = { sectionIndex: 0, part: PART_GROUPS[0].id, rate: 1 };
  let sections = [];
  let running = false;

  function markChips(container, activeValue, attr) {
    for (const chip of container.children) {
      chip.classList.toggle("on", chip.dataset[attr] === String(activeValue));
    }
  }

  function renderSections() {
    el.sections.innerHTML = "";
    sections.forEach((s, i) => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "ln-chip";
      chip.dataset.section = String(i);
      chip.innerHTML = `第${i + 1}组 ${fmmss(s.startSec)}–${fmmss(s.endSec)}<small>${partLabel(s.part)}</small>`;
      chip.addEventListener("click", () => {
        selection.sectionIndex = i;
        // 预选"这一段主要在练的部位",用户想改再点第 2 步
        selection.part = s.part;
        markChips(el.sections, i, "section");
        markChips(el.parts, selection.part, "part");
        resetLive();
      });
      el.sections.appendChild(chip);
    });
    markChips(el.sections, selection.sectionIndex, "section");
  }

  function renderParts() {
    el.parts.innerHTML = "";
    for (const group of PART_GROUPS) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "ln-chip";
      chip.dataset.part = group.id;
      chip.textContent = group.label;
      chip.addEventListener("click", () => {
        selection.part = group.id;
        markChips(el.parts, group.id, "part");
        resetLive();
      });
      el.parts.appendChild(chip);
    }
    markChips(el.parts, selection.part, "part");
  }

  function renderRates() {
    el.rates.innerHTML = "";
    for (const rate of RATES) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "ln-chip";
      chip.dataset.rate = String(rate.value);
      chip.textContent = rate.label;
      chip.addEventListener("click", () => {
        selection.rate = rate.value;
        markChips(el.rates, rate.value, "rate");
      });
      el.rates.appendChild(chip);
    }
    markChips(el.rates, selection.rate, "rate");
  }

  function renderBars(parts, worstId) {
    el.bars.innerHTML = "";
    for (const group of PART_GROUPS) {
      const found = parts?.find((p) => p.id === group.id);
      const row = document.createElement("div");
      row.className = "ln-bar" + (group.id === worstId ? " weak" : "");
      row.dataset.part = group.id;
      const pct = found && found.score != null ? Math.round(found.score * 100) : 0;
      row.innerHTML = `<span>${group.label}</span><i><b style="width:${pct}%"></b></i>` +
        `<span>${found && found.score != null ? pct + "%" : "—"}</span>`;
      el.bars.appendChild(row);
    }
  }

  function resetLive() {
    el.live.classList.add("hidden");
    renderBars(null, null);
    el.fix.textContent = "";
  }

  function setRunning(next) {
    running = !!next;
    el.start.disabled = running || !sections.length;
    el.stop.disabled = !running;
    el.merge.disabled = running;
    for (const chip of el.sections.children) chip.disabled = running;
    for (const chip of el.parts.children) chip.disabled = running;
    el.start.textContent = running ? "练习中…" : "开始这一组";
  }

  el.start.addEventListener("click", () => {
    if (running || !sections.length) return;
    onPractice?.({ ...selection });
  });
  el.stop.addEventListener("click", () => onStop?.());
  el.merge.addEventListener("click", () => onMerge?.());
  el.exit.addEventListener("click", () => onExit?.());

  renderParts();
  renderRates();
  setRunning(false);

  return {
    selection,
    /** 打开面板并填入这一支舞切好的组 */
    open({ label, list }) {
      sections = list ?? [];
      selection.sectionIndex = 0;
      if (sections.length) selection.part = sections[0].part;
      el.song.textContent = `${label} · 共 ${sections.length} 组`;
      renderSections();
      renderParts();
      resetLive();
      el.status.textContent = sections.length
        ? "选好组和部位,点「开始这一组」。跳完一遍自动从头再来。"
        : "这支舞切不出可练的组";
      root.classList.remove("hidden");
      setRunning(false);
    },
    close() {
      root.classList.add("hidden");
      setRunning(false);
    },
    setRunning,
    setStatus(text) { el.status.textContent = text ?? ""; },
    /** 每一遍的实时 HUD;parts 传 null 表示这遍还没数据 */
    setLive({ rep, repScore, best, parts, worstId }) {
      el.live.classList.remove("hidden");
      el.rep.textContent = String(rep ?? 1);
      el.score.textContent = String(Math.round(repScore ?? 0));
      el.best.textContent = String(Math.round(best ?? 0));
      renderBars(parts, worstId);
      el.fix.textContent = worstId ? fixText(worstId, parts?.find((p) => p.id === worstId)?.score) : "";
    },
  };
}
