/**
 * sections.js — 学舞模式的「拆段」逻辑。
 *
 * 全是纯函数:不碰 DOM、不碰音频,只吃序列 JSON 吐数据 → 可直接在 Node 里单测
 * (见 test/learn-sections.test.js)。
 *
 * 教舞的三层拆分,这里做了两层:
 *   1) 按音乐分段 —— timing/v1 的 downbeatsSec(下拍),每 barsPerSection 小节一刀;
 *      没有 timing 就退化成按秒硬切。线下教舞就是"一组八拍一组八拍地教"。
 *   2) 按部位推断 —— 算每条骨骼的角速度(弧度/秒),取平均最大的那一组当默认建议。
 *   3) 走位 —— 未实现(要新写髋部水平位移的度量,还没有验证手段)。
 */
import { BONE_DEFS } from "../../pose_capture/contract.js";
import { DEFAULT_BONE_WEIGHTS } from "../../scoring/src/schema.js";
import { frameCompleteness, framePoseScore } from "../../scoring/src/poseScore.js";
import { TimingMap } from "../audio.js";

/** 部位分组。bones 里的名字必须在 BONE_DEFS 里找得到(找不到直接忽略,不会错位)。 */
export const PART_GROUPS = [
  { id: "arms", label: "手部", bones: ["upper_arm_l", "forearm_l", "upper_arm_r", "forearm_r"] },
  { id: "legs", label: "腿部", bones: ["thigh_l", "shin_l", "thigh_r", "shin_r"] },
  { id: "torso", label: "躯干", bones: ["spine", "head"] },
];

const BONE_INDEX = new Map(BONE_DEFS.map((b, i) => [b.name, i]));
const BONE_COUNT = DEFAULT_BONE_WEIGHTS.length;
const DEFAULT_PART = "torso";
// 相邻帧间隔超过这个值就当成丢帧,不参与角速度统计(否则会算出假尖峰)
const MAX_PAIR_DT = 0.5;
const EPS = 1e-6;

const SPLIT_DEFAULTS = { barsPerSection: 4, fallbackSec: 8, minSec: 2 };

export function partLabel(partId) {
  return PART_GROUPS.find((p) => p.id === partId)?.label ?? partId;
}

/** 部位 → 骨骼下标(0..9,与 DEFAULT_BONE_WEIGHTS 同序)。未知部位返回 null。 */
export function partIndexes(partId) {
  const group = PART_GROUPS.find((p) => p.id === partId);
  if (!group) return null;
  return group.bones.map((name) => BONE_INDEX.get(name)).filter((i) => i !== undefined);
}

/**
 * 只留目标部位的权重,其余置 0。
 * framePoseScore 按"剩余权重"自动重新归一化,所以置 0 就等于"只判这个部位";
 * 全 0 时它返回 0(不是 NaN),也不会除零。
 */
export function weightsForPart(partId, base = DEFAULT_BONE_WEIGHTS) {
  const idx = partIndexes(partId);
  if (!idx) return base.slice();
  const w = base.map(() => 0);
  for (const i of idx) w[i] = base[i] ?? 0;
  return w;
}

/**
 * 把一条谱面事件的权重换成"只判某部位"。
 * 用事件自己的权重当底(有的谱面 note 只标了子集部位),
 * 若交集为空(该音符压根不判这个部位)则退回该部位的完整权重,避免整条必然 MISS。
 */
export function maskEventWeights(eventWeights, partId) {
  const base = Array.isArray(eventWeights) && eventWeights.length === BONE_COUNT
    ? eventWeights
    : DEFAULT_BONE_WEIGHTS;
  const masked = weightsForPart(partId, base);
  if (masked.some((w) => w > 0)) return masked;
  return weightsForPart(partId, DEFAULT_BONE_WEIGHTS);
}

function dot3(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function isZeroVec(v) {
  return !v || !Number.isFinite(v[0] + v[1] + v[2]) || Math.hypot(v[0], v[1], v[2]) < EPS;
}

/**
 * 每条骨骼的平均角速度(弧度/秒)= 相邻帧夹角 ÷ 帧间隔。
 *
 * 为什么必须用角速度而不是姿态相似度:`1 - dot(a,b)` 这种量级只有 1e-3,
 * 在整段尺度上根本分不出"手在甩"和"手没动";角速度才有 O(1) 的区分度。
 */
export function angularVelocity(seq, { fromSec = -Infinity, toSec = Infinity } = {}) {
  const sum = new Array(BONE_COUNT).fill(0);
  const count = new Array(BONE_COUNT).fill(0);
  const frames = seq?.frames ?? [];
  for (let k = 1; k < frames.length; k++) {
    const prev = frames[k - 1];
    const cur = frames[k];
    if (!prev || !cur) continue;
    const dt = cur.t - prev.t;
    if (!(dt > 0) || dt > MAX_PAIR_DT) continue; // 丢帧/倒序:整对跳过
    if (cur.t < fromSec || cur.t > toSec) continue;
    const a = prev.bones;
    const b = cur.bones;
    if (!Array.isArray(a) || !Array.isArray(b)) continue;
    for (let i = 0; i < BONE_COUNT; i++) {
      if (isZeroVec(a[i]) || isZeroVec(b[i])) continue;
      const ang = Math.acos(Math.min(1, Math.max(-1, dot3(a[i], b[i]))));
      sum[i] += ang / dt;
      count[i] += 1;
    }
  }
  return sum.map((s, i) => (count[i] ? s / count[i] : 0));
}

/** 这段主要在练哪个部位:各组骨骼平均角速度的最大者。整段几乎不动时给 DEFAULT_PART。 */
export function inferPart(seq, fromSec = -Infinity, toSec = Infinity) {
  const vel = angularVelocity(seq, { fromSec, toSec });
  let best = DEFAULT_PART;
  let bestVal = 0;
  for (const group of PART_GROUPS) {
    const idx = partIndexes(group.id);
    if (!idx.length) continue;
    const avg = idx.reduce((s, i) => s + vel[i], 0) / idx.length;
    if (avg > bestVal) { bestVal = avg; best = group.id; }
  }
  return best;
}

/**
 * 把"某个契约模式(如 gesture 只有 6 条骨骼)"的 defs 映射成 10 槽位的权重基准。
 * 用法与 scoring-adapter 内部一致:按名字找下标,顺序不能靠位置猜。
 */
export function defWeightsFor(defs) {
  return (defs ?? []).map((d) => DEFAULT_BONE_WEIGHTS[BONE_INDEX.get(d.name)] ?? 0);
}

/**
 * 逐部位打分:同一帧姿态,分别用"只判手部/腿部/躯干"的权重算一次。
 * 用来告诉学员"这一下是哪里没到位",不需要改判定引擎。
 */
export function poseScoreByPart(ref, player, weights = DEFAULT_BONE_WEIGHTS) {
  if (!ref?.bones || !player?.bones) return [];
  return PART_GROUPS.map((group) => {
    const idx = partIndexes(group.id);
    const w = weightsForPart(group.id, weights);
    const conf = w.map((_, i) => Math.min(ref.conf?.[i] ?? 1, player.conf?.[i] ?? 1));
    const visible = frameCompleteness(w, conf) >= 0.5;
    return {
      id: group.id,
      label: group.label,
      score: visible ? framePoseScore(ref.bones, player.bones, w, conf) : null,
    };
  });
}

function sequenceDuration(seq) {
  const declared = Number(seq?.meta?.durationSec);
  if (Number.isFinite(declared) && declared > 0) return declared;
  const frames = seq?.frames ?? [];
  return frames.length ? frames[frames.length - 1].t : 0;
}

/** 切点(秒,升序,含 0 与 durationSec)。有 timing 就用下拍,否则按秒硬切。 */
export function sectionCuts(seq, opts = {}) {
  const { barsPerSection, fallbackSec } = { ...SPLIT_DEFAULTS, ...opts };
  const durationSec = sequenceDuration(seq);
  if (!(durationSec > 0)) return [];
  const cuts = [];
  const timing = seq?.meta?.timing;
  let downbeats = null;
  if (timing?.version === "timing/v1") {
    try { downbeats = new TimingMap(timing, durationSec).downbeatsSec; } catch { downbeats = null; }
  }
  if (downbeats && downbeats.length > 1) {
    for (let i = 0; i < downbeats.length; i += barsPerSection) cuts.push(downbeats[i]);
  } else {
    for (let t = 0; t < durationSec; t += fallbackSec) cuts.push(t);
  }
  if (!cuts.length || cuts[0] > EPS) cuts.unshift(0);
  cuts.push(durationSec);
  return [...new Set(cuts)].filter((t) => t >= 0 && t <= durationSec + EPS).sort((a, b) => a - b);
}

/** 丢掉"会切出太短一段"的刀口:前面不足 minSec,或切完后面只剩个更短的尾巴 */
function mergeShortCuts(cuts, minSec) {
  if (cuts.length <= 2) return cuts;
  const end = cuts[cuts.length - 1];
  const bounds = [cuts[0]];
  for (let i = 1; i < cuts.length - 1; i++) {
    const gap = cuts[i] - bounds[bounds.length - 1];
    const tail = end - cuts[i];
    if (gap < minSec || tail < minSec) continue;
    bounds.push(cuts[i]);
  }
  bounds.push(end);
  return bounds;
}

/**
 * 把整曲切成一组一组。每段带一个默认部位(inferPart 推断结果)供 UI 预选。
 * 返回 [{ index, startSec, endSec, part }]
 */
export function splitSections(seq, opts = {}) {
  const { minSec } = { ...SPLIT_DEFAULTS, ...opts };
  const bounds = mergeShortCuts(sectionCuts(seq, opts), minSec);
  const out = [];
  for (let i = 0; i + 1 < bounds.length; i++) {
    const startSec = bounds[i];
    const endSec = bounds[i + 1];
    if (!(endSec - startSec > 0)) continue;
    out.push({
      index: out.length,
      startSec,
      endSec,
      part: inferPart(seq, startSec, endSec),
    });
  }
  return out;
}

function nearestFrameIndex(frames, t) {
  let lo = 0;
  let hi = frames.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (frames[mid].t < t) lo = mid + 1; else hi = mid;
  }
  if (lo > 0 && Math.abs(frames[lo - 1].t - t) <= Math.abs(frames[lo].t - t)) return lo - 1;
  return lo;
}

/**
 * 从整曲里切一段,做成一个能独立喂给 ScoringAdapter / SongSession 的序列。
 *
 * - frames 重定时刻到 0(只留段内帧),chart.notes 同样重定时刻,并重算 refFrameIdx
 *   (帧被裁掉后原来的下标会越界,parseChart 只会 clamp → 判到错误的参考姿态)
 * - chart.audioOffsetSec = 原值 + startSec → SongSession 直接从这一段的音乐起播，
 *   songTime 也就从 0 走到段长
 * - meta.durationSec = 段长 → 走到段尾就算"唱完了",onSongEnd 正好当循环点
 * - 丢掉 meta.timing:拍栅格是整曲的绝对时刻,重定时刻后是错的(学舞不用节拍脉冲)
 *
 * 段内没有音符或帧不足时返回 null。
 */
export function subSequence(seq, startSec, endSec) {
  const duration = endSec - startSec;
  if (!(duration > 0)) return null;
  const frames = (seq?.frames ?? [])
    .filter((f) => f.t >= startSec - EPS && f.t <= endSec + EPS)
    // max(0, ...) 挡掉 t-startSec 的浮点残差(-1e-15 这种),免得下游出现"负的帧时刻"
    .map((f) => ({ ...f, t: Math.max(0, f.t - startSec) }));
  const chart = seq?.chart;
  if (frames.length < 2 || !Array.isArray(chart?.notes)) return null;
  const notes = chart.notes
    .filter((n) => typeof n.t === "number" && n.t >= startSec - EPS && n.t <= endSec + EPS)
    .map((n) => ({ ...n, t: Math.max(0, n.t - startSec) }));
  if (!notes.length) return null;
  for (const note of notes) note.refFrameIdx = nearestFrameIndex(frames, note.t);
  const meta = { ...seq.meta };
  delete meta.timing;
  meta.durationSec = duration;
  meta.numFrames = frames.length;
  return {
    ...seq,
    meta,
    frames,
    chart: { ...chart, notes, audioOffsetSec: (chart.audioOffsetSec ?? 0) + startSec },
  };
}
