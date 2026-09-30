/**
 * song-library.js — 歌单(songs/index.json)与舞曲序列(songs/<danceId>/<danceId>.json)的文件读取层。
 */
const INDEX_URL = "../songs/index.json";

let index = null;

async function fetchJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`GET ${url} → ${r.status}`);
  return r.json();
}

/** 启动时导入歌单;幂等 */
export async function loadSongIndex() {
  if (index) return index;
  index = await fetchJson(INDEX_URL);
  return index;
}

export function songIndex() {
  return index;
}

/** 保存谱面后强制重读歌单(默认缓存不失效)。 */
export async function reloadSongIndex() {
  index = await fetchJson(INDEX_URL);
  return index;
}

/**
 * 显示名覆盖表。
 * songs/index.json 里的 label 有一部分直接来自 FBX 文件名(如 "Hip Hop Dancing"、"Dance3 Mixamo"),
 * 印在选曲卡和结算界面上很出戏。这里只覆盖【显示层】的 label,
 * **不改 songs/index.json** —— 那份是工具(scoring/src/songIndex.js)生成的共享数据,改了会被下次导出覆盖。
 * 要加名字,往下面两张表里加就行(id 对不上就自动回退用原始 label)。
 */
const DANCE_NAME_CN = {
  hiphop: "街舞律动",
  salsa: "萨尔萨舞",
  "demo-arena-loop": "合成示例舞",
  copydance1: "风萧萧雨萧萧",
  "dance3-mixamo": "舞曲第三号",
  "dance1-video": "舞蹈第一号",
};

const SONG_NAME_CN = {
  "pop-demo": "流行示例曲",
  "samba-demo": "桑巴示例曲",
  "demo-beat": "示例节拍",
  copydance1: "风萧萧雨萧萧",
  "dance3-mixamo": "舞曲第三号 · 原声",
  "dance1-video": "舞蹈第一号",
};

// 只替换 label 字段,其余字段原样透传;表里没有的 id 直接返回原对象
function withName(row, table) {
  return row && table[row.id] ? { ...row, label: table[row.id] } : row;
}

export function dances() {
  return (index?.dances ?? []).map((d) => withName(d, DANCE_NAME_CN));
}

export function songs() {
  return (index?.songs ?? []).map((s) => withName(s, SONG_NAME_CN));
}

// dances()/songs() 已经套过映射,这里直接按 id 取即可
export function danceById(id) {
  return dances().find((d) => d.id === id) ?? null;
}

export function songById(id) {
  return songs().find((s) => s.id === id) ?? null;
}

/**
 * 按 danceId 读入一首舞曲序列(songs/<danceId>/<danceId>.json)。
 * 文件内的 chart.audio / meta.audio 为相对本曲目录的相对路径 → 重基成页面可 fetch 的 URL。
 */
export async function loadSequence(danceId) {
  const fileUrl = `../songs/${danceId}/${danceId}.json`;
  const seq = await fetchJson(fileUrl);
  const base = `../songs/${danceId}/`;
  for (const key of ["chart", "meta"]) {
    const block = seq[key];
    const audio = block?.audio;
    if (audio && typeof audio === "string" && !/^(data:|blob:|https?:|file:|\/)/.test(audio)) {
      block.audio = base + audio;
    }
  }
  return seq;
}