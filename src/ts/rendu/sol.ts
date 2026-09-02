// src/ts/rendu/sol.ts: A ROOM'S FLOOR PATTERN, as an SVG <pattern>. Sizes are written in
// CENTIMETERS then multiplied by `sc` (px/cm), so planks and tiles keep their real dimension at
// any zoom level. `sc` IS MANDATORY: no global fallback, a caller that doesn't know its scale
// must not get a random pattern.

export interface MotifSol {
  /** the `<pattern>`s to place in <defs>; empty for a plain floor */
  defs: string;
  /** what goes into `fill`: `url(#...)` or a color */
  fill: string;
}

/**
 * @param kind `plain` | `tile` | `herringbone` | everything else = parquet
 * @param sc px/cm, the current view scale
 * @param sfx id suffix: one `<pattern>` per SVG (the overview has several)
 */
export function floorPatternDefs(kind: string, sc: number, sfx?: string): MotifSol {
  // Anti blank-page guard (R-17): bounds the pattern's px/cm scale. A <pattern>
  // dimension that is NaN, zero or gigantic (1e6 px) silently fails the SVG raster on the
  // GPU side and can blank the page. All pattern sizes derive from `s`; it is bounded once,
  // here. Largest multiplier = parquet W=220*s; s<=18 keeps every dimension <= ~4096 px.
  let s = sc;
  if (!isFinite(s) || s <= 0) s = 0.5;
  s = Math.max(0.01, Math.min(18, s));
  const FID = "floorFinish" + (sfx || "");
  if (kind === "plain") {
    const c = getComputedStyle(document.documentElement).getPropertyValue("--room-bg").trim() || "#fcfcfa";
    return { defs: "", fill: c };
  }
  if (kind === "tile") {
    const T = 40 * s, grout = "#cfc7b6", base = "#efeae0";
    return {
      defs:
        `<pattern id="${FID}" width="${T}" height="${T}" patternUnits="userSpaceOnUse">
          <rect width="${T}" height="${T}" fill="${base}"/>
          <path d="M ${T} 0 L 0 0 0 ${T}" fill="none" stroke="${grout}" stroke-width="${Math.max(1, 1.2 * s)}"/>
        </pattern>`, fill: "url(#" + FID + ")"
    };
  }
  if (kind === "herringbone") {
    // classic herringbone, interlocked: two planks (60x12 cm) at ±45°.
    const pw = 60 * s, ph = 12 * s;                 // plank, in px
    const cellD = (pw + ph) / Math.SQRT2;           // side of the repeating diagonal cell (px)
    const cA = "#e3cda8", cB = "#dcc39a", seam = "#c9ad7f";
    const T = cellD * 2;
    // Two rotated groups would have worked; simpler: an interlocked L of two rectangles in
    // a square cell, and it's the WHOLE PATTERN that gets rotated by 45°.
    const half = cellD;
    return {
      defs:
        `<pattern id="${FID}" width="${T}" height="${T}" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="${T}" height="${T}" fill="${cA}"/>
          <g stroke="${seam}" stroke-width="${Math.max(0.8, s)}">
            <rect x="0"     y="0"     width="${half}" height="${half}" fill="${cA}"/>
            <rect x="${half}" y="0"   width="${half}" height="${half}" fill="${cB}"/>
            <rect x="0"     y="${half}" width="${half}" height="${half}" fill="${cB}"/>
            <rect x="${half}" y="${half}" width="${half}" height="${half}" fill="${cA}"/>
          </g>
        </pattern>`, fill: "url(#" + FID + ")"
    };
  }
  // parquet (default): straight oak planks, joints every ~18 cm, ends staggered ~110 cm
  const plank = 18 * s, joint = 110 * s, base = "#e7d3b1", alt = "#e2cca6", seam = "#cdb488", endj = "#c3a878";
  const T = plank * 4, W = joint * 2;
  return {
    defs:
      `<pattern id="${FID}" width="${W}" height="${T}" patternUnits="userSpaceOnUse">
        <rect width="${W}" height="${T}" fill="${base}"/>
        <rect y="${plank}"   width="${W}" height="${plank}" fill="${alt}"/>
        <rect y="${plank * 3}" width="${W}" height="${plank}" fill="${alt}"/>
        <g stroke="${seam}" stroke-width="${Math.max(0.8, 1.1 * s)}">
          <line x1="0" y1="0"          x2="${W}" y2="0"/>
          <line x1="0" y1="${plank}"   x2="${W}" y2="${plank}"/>
          <line x1="0" y1="${plank * 2}" x2="${W}" y2="${plank * 2}"/>
          <line x1="0" y1="${plank * 3}" x2="${W}" y2="${plank * 3}"/>
        </g>
        <g stroke="${endj}" stroke-width="${Math.max(0.8, 1.1 * s)}">
          <line x1="${joint}"   y1="0"          x2="${joint}"   y2="${plank}"/>
          <line x1="0"          y1="${plank}"   x2="0"          y2="${plank * 2}"/>
          <line x1="${joint}"   y1="${plank}"   x2="${joint}"   y2="${plank * 2}"/>
          <line x1="${joint}"   y1="${plank * 2}" x2="${joint}"   y2="${plank * 3}"/>
          <line x1="0"          y1="${plank * 3}" x2="0"          y2="${plank * 4}"/>
          <line x1="${joint}"   y1="${plank * 3}" x2="${joint}"   y2="${plank * 4}"/>
        </g>
      </pattern>`, fill: "url(#" + FID + ")"
  };
}
