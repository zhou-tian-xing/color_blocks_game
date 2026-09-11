/**
 * 色彩科学：sRGB ↔ CIE XYZ(D65) ↔ CIE L*a*b*，CIEDE2000 色差，
 * 以及"在 sRGB 色域内、按 8bit 量化后仍能精确达到目标 ΔE00"的刺激色生成。
 *
 * 纯计算模块，不依赖 DOM，可在 Node 中直接测试。
 */

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/* ────────────────────────────── 色彩空间转换 ────────────────────────────── */

// D65 标准光源
const WHITE = [0.95047, 1.0, 1.08883];
const EPS = 216 / 24389; // (6/29)^3
const KAPPA = 24389 / 27;

export function srgbToLinear(c) {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

export function linearToSrgb(v) {
  return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}

/** [0..255] sRGB → CIE L*a*b* */
export function rgbToLab(rgb) {
  const R = srgbToLinear(rgb[0]);
  const G = srgbToLinear(rgb[1]);
  const B = srgbToLinear(rgb[2]);

  const X = (0.4124564 * R + 0.3575761 * G + 0.1804375 * B) / WHITE[0];
  const Y = (0.2126729 * R + 0.7151522 * G + 0.072175 * B) / WHITE[1];
  const Z = (0.0193339 * R + 0.119192 * G + 0.9503041 * B) / WHITE[2];

  const f = (t) => (t > EPS ? Math.cbrt(t) : (KAPPA * t + 16) / 116);
  const fx = f(X);
  const fy = f(Y);
  const fz = f(Z);

  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** CIE L*a*b* → 线性 sRGB（未裁剪，值域约为 0..1） */
export function labToLinearRgb(lab) {
  const [L, a, b] = lab;
  const fy = (L + 16) / 116;
  const fx = fy + a / 500;
  const fz = fy - b / 200;

  const inv = (t) => (t * t * t > EPS ? t * t * t : (116 * t - 16) / KAPPA);
  const X = inv(fx) * WHITE[0];
  const Y = (L > KAPPA * EPS ? Math.pow((L + 16) / 116, 3) : L / KAPPA) * WHITE[1];
  const Z = inv(fz) * WHITE[2];

  return [
    3.2404542 * X - 1.5371385 * Y - 0.4985314 * Z,
    -0.969266 * X + 1.8760108 * Y + 0.041556 * Z,
    0.0556434 * X - 0.2040259 * Y + 1.0572252 * Z,
  ];
}

/** CIE L*a*b* → [0..255] 整数 sRGB（超色域部分裁剪） */
export function labToRgb(lab) {
  const lin = labToLinearRgb(lab);
  return [
    clamp(Math.round(linearToSrgb(clamp(lin[0], 0, 1)) * 255), 0, 255),
    clamp(Math.round(linearToSrgb(clamp(lin[1], 0, 1)) * 255), 0, 255),
    clamp(Math.round(linearToSrgb(clamp(lin[2], 0, 1)) * 255), 0, 255),
  ];
}

/** 该 Lab 颜色是否落在 sRGB 色域内（eps 容忍线性域上的浮点误差） */
export function inGamut(lab, eps = 0.0018) {
  const lin = labToLinearRgb(lab);
  for (let i = 0; i < 3; i++) {
    if (!Number.isFinite(lin[i]) || lin[i] < -eps || lin[i] > 1 + eps) return false;
  }
  return true;
}

export const rgbCss = (rgb) => `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;

/* ─────────────────────────────── CIEDE2000 ─────────────────────────────── */

const DEG = Math.PI / 180;
const P25_7 = Math.pow(25, 7);

function hueDeg(a, b) {
  if (a === 0 && b === 0) return 0;
  const h = Math.atan2(b, a) / DEG;
  return h < 0 ? h + 360 : h;
}

/** CIEDE2000 色差（kL = kC = kH = 1） */
export function deltaE2000(lab1, lab2) {
  const [L1, a1, b1] = lab1;
  const [L2, a2, b2] = lab2;

  const C1 = Math.hypot(a1, b1);
  const C2 = Math.hypot(a2, b2);
  const Cbar = (C1 + C2) / 2;
  const Cbar7 = Math.pow(Cbar, 7);
  const G = 0.5 * (1 - Math.sqrt(Cbar7 / (Cbar7 + P25_7)));

  const a1p = (1 + G) * a1;
  const a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1);
  const C2p = Math.hypot(a2p, b2);
  const h1p = hueDeg(a1p, b1);
  const h2p = hueDeg(a2p, b2);

  const dLp = L2 - L1;
  const dCp = C2p - C1p;

  let dhp = 0;
  if (C1p * C2p !== 0) {
    dhp = h2p - h1p;
    if (dhp > 180) dhp -= 360;
    else if (dhp < -180) dhp += 360;
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp / 2) * DEG);

  const Lbarp = (L1 + L2) / 2;
  const Cbarp = (C1p + C2p) / 2;

  let hbarp;
  if (C1p * C2p === 0) {
    hbarp = h1p + h2p;
  } else if (Math.abs(h1p - h2p) <= 180) {
    hbarp = (h1p + h2p) / 2;
  } else if (h1p + h2p < 360) {
    hbarp = (h1p + h2p + 360) / 2;
  } else {
    hbarp = (h1p + h2p - 360) / 2;
  }

  const T =
    1 -
    0.17 * Math.cos((hbarp - 30) * DEG) +
    0.24 * Math.cos(2 * hbarp * DEG) +
    0.32 * Math.cos((3 * hbarp + 6) * DEG) -
    0.2 * Math.cos((4 * hbarp - 63) * DEG);

  const dTheta = 30 * Math.exp(-Math.pow((hbarp - 275) / 25, 2));
  const Cbarp7 = Math.pow(Cbarp, 7);
  const RC = 2 * Math.sqrt(Cbarp7 / (Cbarp7 + P25_7));

  const SL = 1 + (0.015 * Math.pow(Lbarp - 50, 2)) / Math.sqrt(20 + Math.pow(Lbarp - 50, 2));
  const SC = 1 + 0.045 * Cbarp;
  const SH = 1 + 0.015 * Cbarp * T;
  const RT = -Math.sin(2 * dTheta * DEG) * RC;

  return Math.sqrt(
    Math.pow(dLp / SL, 2) +
      Math.pow(dCp / SC, 2) +
      Math.pow(dHp / SH, 2) +
      RT * (dCp / SC) * (dHp / SH),
  );
}

/** 仅用于展示/调试，测试本身使用 ΔE00 */
export function deltaE76(lab1, lab2) {
  return Math.hypot(lab1[0] - lab2[0], lab1[1] - lab2[1], lab1[2] - lab2[2]);
}

/* ─────────────────────────── 刺激色（色块）生成 ─────────────────────────── */

function addScaled(base, dir, s) {
  return [base[0] + dir[0] * s, base[1] + dir[1] * s, base[2] + dir[2] * s];
}

function normalize3(v) {
  const n = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / n, v[1] / n, v[2] / n];
}

/** 沿 dir 方向、仍留在 sRGB 色域内的最大步长（Lab 距离） */
function maxScale(base, dir) {
  if (!inGamut(base)) return 0;
  let lo = 0;
  let hi = 1;
  while (hi < 8192 && inGamut(addScaled(base, dir, hi))) {
    lo = hi;
    hi *= 2;
  }
  if (inGamut(addScaled(base, dir, hi))) return hi;
  for (let i = 0; i < 46; i++) {
    const mid = (lo + hi) / 2;
    if (inGamut(addScaled(base, dir, mid))) lo = mid;
    else hi = mid;
  }
  return lo;
}

/**
 * 8bit 量化会让"解析解"失真（尤其在小 ΔE 时），
 * 因此在解析解附近的整数网格里做一次邻域精修，取量化后 ΔE 最接近目标的那个颜色。
 */
function refineOnLattice(baseLab, seedRgb, targetDE) {
  let best = null;
  let bestErr = Infinity;

  for (let dr = -4; dr <= 4; dr++) {
    for (let dg = -4; dg <= 4; dg++) {
      for (let db = -4; db <= 4; db++) {
        const rgb = [seedRgb[0] + dr, seedRgb[1] + dg, seedRgb[2] + db];
        if (rgb[0] < 0 || rgb[0] > 255 || rgb[1] < 0 || rgb[1] > 255 || rgb[2] < 0 || rgb[2] > 255) continue;
        const lab = rgbToLab(rgb);
        const de = deltaE2000(baseLab, lab);
        if (de < 0.12) continue; // 与底色完全一致（或肉眼不可分）的候选直接排除
        const err = Math.abs(de - targetDE);
        if (err < bestErr) {
          bestErr = err;
          best = { rgb, lab, de };
        }
      }
    }
  }
  return best;
}

/**
 * 生成一轮刺激：一组同色色块 + 一个色差为 targetDE 的异色色块。
 *
 * @param {number} targetDE 目标色差 ΔE00
 * @param {() => number} rng 随机源
 * @returns {{baseRgb:number[], oddRgb:number[], baseLab:number[], oddLab:number[], deltaE:number}|null}
 *          返回的是"量化后实际呈现"的色差 deltaE（可能与 targetDE 略有出入，游戏按实际值记录）
 */
export function makeStimulus(targetDE, rng = Math.random) {
  let fallback = null;

  for (let attempt = 0; attempt < 120; attempt++) {
    // 底色：明度 52~78，彩度 0~46，色相随机 → 每轮换一个色系，避免被试适应单一色相
    const L0 = 52 + rng() * 26;
    const C0 = rng() * 46;
    const psi = rng() * Math.PI * 2;
    const baseLabRaw = [L0, C0 * Math.cos(psi), C0 * Math.sin(psi)];
    if (!inGamut(baseLabRaw)) continue;

    const baseRgb = labToRgb(baseLabRaw);
    const baseLab = rgbToLab(baseRgb); // 量化之后的真实底色

    // 偏移方向：以 (a*,b*) 平面为主，掺一点明度分量
    const phi = rng() * Math.PI * 2;
    const dir = normalize3([(rng() * 2 - 1) * 0.32, Math.cos(phi), Math.sin(phi)]);

    const sMax = maxScale(baseLab, dir);
    if (sMax <= 0) continue;
    if (deltaE2000(baseLab, addScaled(baseLab, dir, sMax)) < targetDE) continue; // 该方向走不到目标色差

    let lo = 0;
    let hi = sMax;
    for (let i = 0; i < 48; i++) {
      const mid = (lo + hi) / 2;
      if (deltaE2000(baseLab, addScaled(baseLab, dir, mid)) < targetDE) lo = mid;
      else hi = mid;
    }

    const seed = labToRgb(addScaled(baseLab, dir, (lo + hi) / 2));
    const snapped = refineOnLattice(baseLab, seed, targetDE);
    if (!snapped) continue;

    const result = {
      baseRgb,
      oddRgb: snapped.rgb,
      baseLab,
      oddLab: snapped.lab,
      deltaE: snapped.de,
    };
    if (snapped.de >= 0.15) return result;
    fallback = fallback || result;
  }

  return fallback;
}
