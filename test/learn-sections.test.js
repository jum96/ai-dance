/**
 * test/learn-sections.test.js — 学舞模式拆段逻辑的单测。
 *
 * sections.js 是纯函数(不碰 DOM / 音频),所以整块逻辑能在 Node 里跑。
 * 摄像头在当前机器上不通,这套单测是"拆段/切子序列"唯一的验证手段。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { BONE_DEFS } from "../pose_capture/contract.js";
import { DEFAULT_BONE_WEIGHTS } from "../scoring/src/schema.js";
import {
  PART_GROUPS,
  angularVelocity,
  inferPart,
  maskEventWeights,
  partIndexes,
  partLabel,
  poseScoreByPart,
  sectionCuts,
  splitSections,
  subSequence,
  weightsForPart,
} from "../web_dance/learn/sections.js";

const BONE_COUNT = DEFAULT_BONE_WEIGHTS.length;

function assertClose(actual, expected, msg = "", eps = 1e-6) {
  assert.ok(Math.abs(actual - expected) < eps, `${msg} 期望 ${expected},实际 ${actual}`);
}

/** 绕 Y 轴转 angle 的单位向量 */
const spin = (angle) => [Math.cos(angle), 0, Math.sin(angle)];
const STILL = {
  1: [0, 1, 0], 2: [0, 1, 0], 3: [0, 1, 0], 4: [0, 1, 0],
  5: [0, -1, 0], 6: [0, -1, 0], 7: [0, -1, 0], 8: [0, -1, 0],
  0: [0, 1, 0], 9: [0, 1, 0],
};

/**
 * 造一段合成序列。armSpin/legSpin 是"每帧转多少弧度"(0 = 不动),
 * 用来验证角速度推断能不能认出这段主要练哪儿。
 */
function makeSeq({ durationSec = 16, fps = 30, timing = null, notes = null, armSpin = 0, legSpin = 0 } = {}) {
  const n = Math.round(durationSec * fps);
  const frames = [];
  for (let i = 0; i <= n; i++) {
    const t = i / fps;
    const bones = [];
    for (let b = 0; b < BONE_COUNT; b++) {
      if (armSpin && (b === 1 || b === 2 || b === 3 || b === 4)) bones.push(spin(i * armSpin));
      else if (legSpin && (b === 5 || b === 6 || b === 7 || b === 8)) bones.push(spin(i * legSpin));
      else bones.push(STILL[b].slice());
    }
    frames.push({ t, bones, conf: new Array(BONE_COUNT).fill(1), rootYaw: 0 });
  }
  return {
    schema: "dance-sequence/v1",
    danceId: "learn-test",
    meta: {
      fps, durationSec, numFrames: frames.length, boneCount: BONE_COUNT,
      danceType: "full-body",
      ...(timing ? { timing } : {}),
    },
    bones: BONE_DEFS,
    frames,
    chart: {
      version: "chart/v2",
      audio: "../songs/learn-test/learn-test.wav",
      notes: notes ?? [
        { id: "n0", t: 0, type: "pose" },
        { id: "n1", t: 4, type: "pose" },
        { id: "n2", t: 8, type: "pose" },
        { id: "n3", t: 12, type: "pose" },
      ],
    },
  };
}

const constantTiming = (bpm = 120) => ({ version: "timing/v1", bpm, offsetSec: 0, tempoMap: [{ t: 0, bpm }] });

// ---------------------------------------------------------------------------
// 部位 → 权重
// ---------------------------------------------------------------------------
test("部位骨骼下标对得上 BONE_DEFS(手 1-4 / 腿 5-8 / 躯干 0,9)", () => {
  assert.deepEqual(partIndexes("arms"), [1, 2, 3, 4]);
  assert.deepEqual(partIndexes("legs"), [5, 6, 7, 8]);
  assert.deepEqual(partIndexes("torso"), [0, 9]);
  assert.equal(partIndexes("nope"), null);
  assert.equal(partLabel("arms"), "手部");
  assert.equal(partLabel("nope"), "nope");
});

test("weightsForPart:只留目标部位,其余置 0(归一化交给 framePoseScore 按剩余权重重算)", () => {
  const w = weightsForPart("arms");
  assert.equal(w.length, BONE_COUNT);
  for (const i of [1, 2, 3, 4]) assert.equal(w[i], DEFAULT_BONE_WEIGHTS[i], `idx ${i} 该保留原权重`);
  for (const i of [0, 5, 6, 7, 8, 9]) assert.equal(w[i], 0);
  const sum = w.reduce((a, b) => a + b, 0);
  const expect = [1, 2, 3, 4].reduce((s, i) => s + DEFAULT_BONE_WEIGHTS[i], 0);
  assert.ok(Math.abs(sum - expect) < 1e-9, `权重和应为 ${expect},实际 ${sum}`);
});

test("weightsForPart:基权重全 0 时不抛错,结果仍全 0", () => {
  const w = weightsForPart("legs", new Array(BONE_COUNT).fill(0));
  assert.deepEqual(w, new Array(BONE_COUNT).fill(0));
});

test("maskEventWeights:用事件自己的子集权重;交集为空时退回该部位完整权重(避免必然 MISS)", () => {
  // 事件只判手部 → 练手部时保留,练腿部时交集为空 → 退回腿部完整权重
  const armOnly = weightsForPart("arms");
  assert.deepEqual(maskEventWeights(armOnly, "arms"), weightsForPart("arms", armOnly));
  const fallback = maskEventWeights(armOnly, "legs");
  assert.ok(fallback.some((w) => w > 0), "交集为空时必须给回权重,否则整条音符必然 MISS");
  assert.equal(fallback[5] > 0, true);
  // 事件权重长度不对(旧谱面)时按默认权重要求处理,不越界
  assert.equal(maskEventWeights([1, 1], "torso").length, BONE_COUNT);
});

// ---------------------------------------------------------------------------
// 角速度 → 部位推断
// ---------------------------------------------------------------------------
test("angularVelocity: 不动的骨骼角速度 ≈ 0,每帧转 0.5 弧度的手部 ≈ 15 rad/s", () => {
  const seq = makeSeq({ durationSec: 2, armSpin: 0.5 });
  const v = angularVelocity(seq);
  assert.equal(v.length, BONE_COUNT);
  // dt = 1/30 → 0.5 rad / (1/30) = 15 rad/s
  assert.ok(Math.abs(v[1] - 15) < 1e-6, `手部角速度 ${v[1]}`);
  assert.ok(v[5] < 1e-9, `腿部该是 0,实际 ${v[5]}`);
});

test("angularVelocity: 丢帧(间隔 > 0.5s)的帧对不参与统计,不会算出假尖峰", () => {
  const seq = makeSeq({ durationSec: 2, armSpin: 0 });
  // 把第 30 帧整体挪后 1 秒,制造一个 1 秒的空档
  for (const b of [1]) seq.frames[30].bones[b] = spin(Math.PI);
  seq.frames[30].t += 1.0;
  const v = angularVelocity(seq);
  assert.ok(v[1] < 0.2, `空档前后的夹角不该被算进去,实际 ${v[1]}`);
});

test("inferPart: 手在甩 → arms;腿在甩 → legs;全员不动 → 兜底 torso", () => {
  assert.equal(inferPart(makeSeq({ durationSec: 4, armSpin: 0.5 })), "arms");
  assert.equal(inferPart(makeSeq({ durationSec: 4, legSpin: 0.5 })), "legs");
  assert.equal(inferPart(makeSeq({ durationSec: 4 })), "torso");
});

test("inferPart: 只在该段的时间范围内统计", () => {
  const seq = makeSeq({ durationSec: 8, armSpin: 0.5 });
  // 后半段改成腿在动
  for (let i = 120; i < seq.frames.length; i++) {
    for (const b of [1, 2, 3, 4]) seq.frames[i].bones[b] = STILL[b].slice();
    for (const b of [5, 6, 7, 8]) seq.frames[i].bones[b] = spin(i * 0.5);
  }
  assert.equal(inferPart(seq, 0, 4), "arms");
  assert.equal(inferPart(seq, 4, 8), "legs");
});

test("poseScoreByPart: 姿态一致时三部位都满分;手部乱了则手部分数明显低于腿部", () => {
  const seq = makeSeq({ durationSec: 1 });
  const ref = seq.frames[0];
  const same = poseScoreByPart(ref, ref);
  assert.deepEqual(same.map((p) => p.id), ["arms", "legs", "torso"]);
  for (const p of same) assert.ok(Math.abs(p.score - 1) < 1e-9, `${p.label} 应满分,实际 ${p.score}`);

  const broken = { bones: ref.bones.map((b, i) => ([1, 2, 3, 4].includes(i) ? spin(Math.PI) : b)), conf: ref.conf };
  const scores = poseScoreByPart(ref, broken);
  const arms = scores.find((p) => p.id === "arms").score;
  const legs = scores.find((p) => p.id === "legs").score;
  assert.ok(arms < legs, `手部 ${arms} 该低于腿部 ${legs}`);
  assert.ok(legs > 0.99);
});

// ---------------------------------------------------------------------------
// 分段
// ---------------------------------------------------------------------------
test("sectionCuts: 有 timing 时按每 4 小节一刀(120BPM → 每 8 秒)", () => {
  const seq = makeSeq({ durationSec: 16, timing: constantTiming(120) });
  assert.deepEqual(sectionCuts(seq), [0, 8, 16]);
});

test("sectionCuts: 没有 timing 时按秒硬切,且一定包含 0 与曲长", () => {
  const seq = makeSeq({ durationSec: 20 });
  assert.deepEqual(sectionCuts(seq), [0, 8, 16, 20]);
});

test("splitSections: 每段带一个推断出来的默认部位", () => {
  const seq = makeSeq({ durationSec: 16, timing: constantTiming(120), armSpin: 0.5 });
  const sections = splitSections(seq);
  assert.equal(sections.length, 2);
  assert.deepEqual(sections.map((s) => [s.startSec, s.endSec]), [[0, 8], [8, 16]]);
  assert.deepEqual(sections.map((s) => s.index), [0, 1]);
  for (const s of sections) assert.equal(s.part, "arms");
});

test("splitSections: 过短的尾段并进前一段,不会切出 1 秒都没到的碎段", () => {
  const seq = makeSeq({ durationSec: 17, timing: constantTiming(120) });
  const sections = splitSections(seq);
  assert.deepEqual(sections.map((s) => [s.startSec, s.endSec]), [[0, 8], [8, 17]]);
});

test("splitSections: 曲长非法/帧为空 → 空数组,不抛错", () => {
  assert.deepEqual(splitSections({ meta: { durationSec: 0 }, frames: [] }), []);
  assert.deepEqual(splitSections(null), []);
});

// ---------------------------------------------------------------------------
// 切子序列
// ---------------------------------------------------------------------------
test("subSequence: 帧与音符都重定时刻到 0,曲长=段长,音频偏移累加", () => {
  const seq = makeSeq({ durationSec: 16, timing: constantTiming(120) });
  const sub = subSequence(seq, 8, 16);
  assert.equal(sub.meta.durationSec, 8);
  assert.equal(sub.meta.numFrames, sub.frames.length);
  assert.equal(sub.frames[0].t, 0, "首帧归零");
  assert.ok(sub.frames.every((f) => f.t >= 0 && f.t <= 8 + 1e-9), "帧都落在段内");
  assert.deepEqual(sub.chart.notes.map((n) => n.t), [0, 4]);
  assert.deepEqual(sub.chart.notes.map((n) => n.id), ["n2", "n3"]);
  assert.equal(sub.chart.audioOffsetSec, 8, "从这一段的音乐开头起播");
  assert.equal(sub.chart.audio, seq.chart.audio, "曲目路径原样保留");
});

test("subSequence: 重算 refFrameIdx —— 帧被裁掉后原下标越界,parseChart 只会 clamp 到错的姿态", () => {
  const seq = makeSeq({ durationSec: 16, timing: constantTiming(120) });
  const sub = subSequence(seq, 8, 16);
  for (const note of sub.chart.notes) {
    assert.ok(Number.isInteger(note.refFrameIdx), "必须是整数下标");
    assert.ok(note.refFrameIdx >= 0 && note.refFrameIdx < sub.frames.length, "不许越界");
    assert.ok(Math.abs(sub.frames[note.refFrameIdx].t - note.t) < 1 / 30, "参考帧要贴着音符时刻");
  }
});

test("subSequence: 丢掉整曲的 timing 栅格(重定时刻后绝对拍点是错的)", () => {
  const seq = makeSeq({ durationSec: 16, timing: constantTiming(120) });
  const sub = subSequence(seq, 0, 8);
  assert.equal(sub.meta.timing, undefined);
  assert.equal(seq.meta.timing.version, "timing/v1", "不能改到原序列");
});

test("subSequence: 段内没音符 / 帧不足 → null", () => {
  const seq = makeSeq({ durationSec: 16, timing: constantTiming(120), notes: [{ id: "a", t: 1, type: "pose" }] });
  assert.equal(subSequence(seq, 8, 16), null, "这一段没有判定点");
  assert.equal(subSequence(seq, -1, 0), null, "帧不足");
  assert.equal(subSequence(seq, 4, 4), null, "零长段");
});

test("subSequence: 不改原序列(纯函数)", () => {
  const seq = makeSeq({ durationSec: 16, timing: constantTiming(120) });
  const before = JSON.stringify(seq);
  subSequence(seq, 0, 8);
  assert.equal(JSON.stringify(seq), before);
});

test("PARTS 常量:三个部位,id 与 sections 里用的一致", () => {
  assert.deepEqual(PART_GROUPS.map((p) => p.id), ["arms", "legs", "torso"]);
});

// ---------------------------------------------------------------------------
// 真实曲库:每支舞都能切段,每段都能切出一条可判定的子序列
// ---------------------------------------------------------------------------
const SONGS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../songs");

function realSequences() {
  const out = [];
  for (const danceId of readdirSync(SONGS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)) {
    const file = resolve(SONGS_DIR, danceId, `${danceId}.json`);
    if (!existsSync(file)) continue;
    out.push([danceId, JSON.parse(readFileSync(file, "utf8"))]);
  }
  return out;
}

test("真实曲库: 每支舞都切得出段,每段都有明确起止与一个推断部位", () => {
  const all = realSequences();
  assert.ok(all.length >= 3, `曲库至少 3 支舞,实际 ${all.length}`);
  for (const [danceId, seq] of all) {
    const sections = splitSections(seq);
    assert.ok(sections.length >= 1, `${danceId} 至少切出一段`);
    let prevEnd = 0;
    for (const s of sections) {
      assert.equal(s.startSec, prevEnd, `${danceId} 第 ${s.index} 段要和上一段首尾相接`);
      assert.ok(s.endSec > s.startSec, `${danceId} 第 ${s.index} 段长度必须为正`);
      assert.ok(["arms", "legs", "torso"].includes(s.part), `${danceId} 部位非法: ${s.part}`);
      prevEnd = s.endSec;
    }
    assertClose(prevEnd, seq.meta.durationSec, `${danceId} 段末要盖到曲尾`);
  }
});

test("真实曲库: 每段都能切出一条自洽的子序列(可直接喂给判定引擎)", () => {
  for (const [danceId, seq] of realSequences()) {
    for (const s of splitSections(seq)) {
      const sub = subSequence(seq, s.startSec, s.endSec);
      assert.ok(sub, `${danceId} 第 ${s.index} 段切不出子序列`);
      // 段起点很少正好落在某一帧上 → 首帧最多晚一帧,不能差出更多
      assert.ok(sub.frames[0].t >= -1e-9 && sub.frames[0].t <= 1 / (seq.meta.fps || 30) + 1e-9,
        `${danceId}#${s.index} 首帧应贴住段首,实际 t=${sub.frames[0].t}`);
      assert.ok(sub.frames.every((f) => f.t >= 0 && f.t <= sub.meta.durationSec + 1e-9));
      assert.equal(sub.meta.durationSec, s.endSec - s.startSec);
      assert.deepEqual(sub.meta.timing, undefined);
      for (const n of sub.chart.notes) {
        assert.ok(n.t >= 0 && n.t <= sub.meta.durationSec + 1e-9, `${danceId}#${s.index} 音符越界 t=${n.t}`);
        assert.ok(n.refFrameIdx >= 0 && n.refFrameIdx < sub.frames.length, `${danceId}#${s.index} refFrameIdx 越界`);
      }
    }
  }
});
