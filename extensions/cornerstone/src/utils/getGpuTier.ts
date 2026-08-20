/**
 * GPU capability tiering for Shealth.
 *
 * WHY THIS EXISTS
 * Radiologists read on whatever hardware their clinic bought. On weak integrated
 * Intel GPUs, opening MPR builds a full-resolution 3D volume texture on top of
 * Cornerstone's multi-context rendering pool, blows past the GPU's memory budget,
 * and the browser kills the WebGL context:
 *
 *     CONTEXT_LOST_WEBGL: loseContext: context lost
 *     TypeError: Cannot read properties of null (reading 'isAttributeUsed')
 *
 * vtk.js keeps drawing on the dead context, so the viewport goes black and STAYS
 * black until a reload. This is a documented Chrome/ANGLE + Intel iGPU problem
 * (cornerstone3D#453, OHIF#3207, chromium#465176577) — not something we can patch
 * away. The only reliable defence is to spend less GPU memory on machines that
 * do not have it.
 *
 * So: detect what we are running on, once, and let init.tsx pick a rendering
 * profile from it. A strong workstation keeps full quality; a weak laptop trades
 * texture precision and context count for staying alive.
 *
 * DETECTION IS DELIBERATELY CONSERVATIVE
 * Guessing "high" on a weak machine is the failure we are trying to prevent, so
 * anything we cannot positively identify is treated as `mid`, and known-weak
 * integrated parts are pinned to `low`.
 */

export type GpuTier = 'low' | 'mid' | 'high';

export interface GpuInfo {
  tier: GpuTier;
  /** Unmasked renderer string, e.g. "ANGLE (Intel, Intel(R) UHD Graphics 630 ...)". */
  renderer: string;
  /** navigator.deviceMemory (GiB) when exposed — Chrome only, coarse (2/4/8). */
  deviceMemory: number | null;
  logicalCores: number;
  /** Max 3D texture edge the driver reports; a hard ceiling on volume size. */
  max3DTextureSize: number | null;
  /** Why this tier was chosen — surfaced in logs and support tickets. */
  reason: string;
}

/**
 * Integrated parts that are known to lose the WebGL context while building a
 * CT-sized volume. Matched case-insensitively against the unmasked renderer.
 *
 * Intel's naming is inconsistent across driver versions ("HD Graphics 620",
 * "UHD Graphics", "Intel(R) Iris(R) Xe"), so we match families rather than exact
 * models, and treat unrecognised Intel integrated as `low` too — see below.
 */
const WEAK_GPU_PATTERNS: RegExp[] = [
  // Skylake-through-Comet-Lake integrated: HD 5xx/6xx and UHD 6xx. These are
  // the parts in the crash reports. Matched on the MODEL NUMBER, not the family
  // name, because "UHD Graphics" also covers 12th-gen-and-later Xe parts that
  // are several times faster - lumping them together on the word "UHD" was
  // demoting current hardware into the tier that cannot reconstruct anything.
  /\b(hd|uhd) graphics [56]\d\d\b/i,
  /\bhd graphics\b(?![^,]*\b[78]\d\d\b)/i,
  /microsoft basic render/i, // no GPU at all - software rasteriser
  /llvmpipe|swiftshader|softwarerasterizer/i, // software GL
  /mesa (dri )?intel/i,
];

/** Discrete / high-end integrated parts we trust with a full-resolution volume. */
const STRONG_GPU_PATTERNS: RegExp[] = [
  /nvidia|geforce|rtx|quadro|tesla/i,
  /radeon (rx|pro)|amd radeon r9|firepro/i,
  /intel\(r\)? arc/i,
  /apple m\d/i, // Apple silicon
];

/** Mid-range integrated that generally survives, but not with 7 contexts. */
const MID_GPU_PATTERNS: RegExp[] = [
  /iris\(r\)? xe|iris plus|iris graphics/i,
  /vega \d+ graphics/i,
  // UHD 730/770 - 12th gen and later, Xe architecture.
  /\buhd graphics [78]\d\d\b/i,
  // "Intel(R) Graphics" with no model number is Meteor Lake / Core Ultra,
  // which is Arc-derived and comfortably mid.
  /intel\(r\)? graphics\b(?!.*\b(hd|uhd)\b)/i,
  // AMD RDNA2 integrated (6000/7000-series APUs).
  /radeon\(tm\)? graphics/i,
];

let cached: GpuInfo | null = null;

function readRenderer(): { renderer: string; max3DTextureSize: number | null } {
  if (typeof document === 'undefined') {
    return { renderer: '', max3DTextureSize: null };
  }
  let gl: WebGL2RenderingContext | WebGLRenderingContext | null = null;
  try {
    const canvas = document.createElement('canvas');
    gl = (canvas.getContext('webgl2') ||
      canvas.getContext('webgl')) as WebGL2RenderingContext | null;
    if (!gl) {
      return { renderer: 'no-webgl', max3DTextureSize: null };
    }

    // WEBGL_debug_renderer_info is the only way to see the real adapter. Some
    // privacy configurations withhold it; an empty string then falls through to
    // the conservative default rather than being mistaken for a strong GPU.
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = ext
      ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) ?? '')
      : String(gl.getParameter(gl.RENDERER) ?? '');

    // MAX_3D_TEXTURE_SIZE only exists on WebGL2 and caps how large a volume can
    // be uploaded at all — worth capturing for the volume-size guard.
    let max3DTextureSize: number | null = null;
    const gl2 = gl as WebGL2RenderingContext;
    if (typeof gl2.MAX_3D_TEXTURE_SIZE !== 'undefined') {
      max3DTextureSize = gl2.getParameter(gl2.MAX_3D_TEXTURE_SIZE) as number;
    }

    // Release the probe context immediately — contexts are the scarce resource
    // we are here to conserve, and browsers cap how many a page may hold.
    const loseCtx = gl.getExtension('WEBGL_lose_context');
    loseCtx?.loseContext();

    return { renderer, max3DTextureSize };
  } catch {
    return { renderer: '', max3DTextureSize: null };
  }
}

function classify(
  renderer: string,
  deviceMemory: number | null,
  cores: number
): { tier: GpuTier; reason: string } {
  const r = renderer.toLowerCase();

  if (!r || r === 'no-webgl') {
    return { tier: 'low', reason: 'renderer unavailable or WebGL missing' };
  }

  if (WEAK_GPU_PATTERNS.some(p => p.test(renderer))) {
    return { tier: 'low', reason: `known-weak GPU: ${renderer}` };
  }

  // The GPU is inspected BEFORE system RAM.
  //
  // navigator.deviceMemory is quantised to powers of two and capped at 8 by
  // spec, so a 32 GB workstation reports 8 and plenty of 8 GB laptops report 4.
  // Reading it first meant a discrete card in a box that happened to report 4
  // was classified as weak - and a discrete GPU's VRAM has nothing to do with
  // how much system RAM the browser was willing to admit to.
  if (STRONG_GPU_PATTERNS.some(p => p.test(renderer))) {
    // A discrete GPU on a genuinely starved host still is not a 'high' machine:
    // decode workers and the staging buffer live in system memory.
    if (deviceMemory !== null && deviceMemory <= 4) {
      return { tier: 'mid', reason: `strong GPU but only ${deviceMemory}GB RAM: ${renderer}` };
    }
    return { tier: 'high', reason: `discrete/high-end GPU: ${renderer}` };
  }

  if (MID_GPU_PATTERNS.some(p => p.test(renderer))) {
    // Integrated parts share system memory, so a starved host does pull them
    // down - but only when RAM is genuinely small, not merely under-reported.
    if (deviceMemory !== null && deviceMemory <= 4) {
      return {
        tier: 'low',
        reason: `mid GPU on a ${deviceMemory}GB host: ${renderer}`,
      };
    }
    return { tier: 'mid', reason: `mid integrated GPU: ${renderer}` };
  }

  // A genuinely tiny host cannot feed a volume build whatever the adapter says.
  if (cores <= 2 || (deviceMemory !== null && deviceMemory <= 2)) {
    return {
      tier: 'low',
      reason: `constrained host (memory=${deviceMemory ?? '?'}GB, cores=${cores})`,
    };
  }

  // Unrecognised Intel integrated: assume it behaves like the parts that crash.
  if (/intel/i.test(renderer)) {
    return { tier: 'low', reason: `unrecognised Intel integrated GPU: ${renderer}` };
  }

  // Anything else unknown: mid. Not 'high' — we never guess our way into the
  // configuration that crashes.
  return { tier: 'mid', reason: `unrecognised GPU, defaulting to mid: ${renderer}` };
}

/**
 * Detect the GPU tier once per session.
 *
 * Overridable with `?gpuTier=low|mid|high` so support can reproduce a
 * radiologist's configuration, and so a machine we misclassify can be corrected
 * without a redeploy. A tier previously forced down by the crash-loop breaker
 * (sessionStorage) wins over detection.
 */
export function getGpuInfo(): GpuInfo {
  if (cached) {
    return cached;
  }

  const nav = typeof navigator !== 'undefined' ? navigator : ({} as Navigator);
  const deviceMemory =
    typeof (nav as Navigator & { deviceMemory?: number }).deviceMemory === 'number'
      ? (nav as Navigator & { deviceMemory?: number }).deviceMemory!
      : null;
  const logicalCores = nav.hardwareConcurrency || 4;

  const { renderer, max3DTextureSize } = readRenderer();
  let { tier, reason } = classify(renderer, deviceMemory, logicalCores);

  // 1. Session downgrade written by the context-loss circuit breaker.
  try {
    const forced = sessionStorage.getItem('shealth.gpuTier.forced');
    if (forced === 'low' || forced === 'mid' || forced === 'high') {
      tier = forced;
      reason = `forced by crash-loop protection (was: ${reason})`;
    }
  } catch {
    /* sessionStorage unavailable (privacy mode) — detection stands */
  }

  // 2. Explicit URL override always wins, for support and QA.
  try {
    const q = new URLSearchParams(window.location.search).get('gpuTier');
    if (q === 'low' || q === 'mid' || q === 'high') {
      tier = q;
      reason = `overridden via ?gpuTier=${q}`;
    }
  } catch {
    /* no window/search — keep detected tier */
  }

  cached = { tier, renderer, deviceMemory, logicalCores, max3DTextureSize, reason };
  return cached;
}

export function getGpuTier(): GpuTier {
  return getGpuInfo().tier;
}

/**
 * Persist a downgraded tier for the rest of the session. Called by the
 * context-loss handler after repeated losses, so a machine that keeps crashing
 * drops to a cheaper profile instead of looping.
 */
export function forceGpuTier(tier: GpuTier): void {
  try {
    sessionStorage.setItem('shealth.gpuTier.forced', tier);
  } catch {
    /* ignore — the in-memory value below still applies for this page */
  }
  if (cached) {
    cached = { ...cached, tier, reason: 'forced by crash-loop protection' };
  }
}

/** Reset detection — tests only. */
export function _resetGpuTierCache(): void {
  cached = null;
}
