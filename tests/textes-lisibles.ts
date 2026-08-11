#!/usr/bin/env node
// =============================================================================
//  "A TEXT READS FLAT" SUITE — REAL PAGE, MEASURED SCREEN ANGLES
// =============================================================================
// Original defect, reported with a screenshot: two sconces placed back to back on the same wall.
// The one on the other face displayed "Applique" upside down, letters mirrored.
//
// The rule has CHANGED, and in the simplest direction. We first held to the drafting-software
// convention (the label FOLLOWS the tilted object, folded into the readable half-circle [-90, +90[).
// Rejected on the real plan: "never write furniture names upside down, should always be readable
// (horizontal)". A furniture name written vertically across the dining corner is unreadable at a
// glance, even if it is not "upside down". The expectation here is therefore simpler AND stronger:
// for ANY rotation of the object, the screen angle of its label equals ZERO. No half-turn, no
// special case, no hinge. The rest of the plan's text (dimensions, guides, room names,
// peer cursors) is drawn in screen space and must stay within the readable range.
//
// What is measured is NOT the inline style but the SCREEN ANGLE, the product of the `transform`s of every
// ancestor: it's the only measurement that matters, a rotated parent is enough to flip a child
// that is otherwise "straight".
//
//   node tests/textes-lisibles.ts [path/to/app.html]
//
//   regle_pure_et_sans_hysteresis    sweep of both hinges in BOTH directions: zero everywhere
//   etiquette_meuble_toujours_horizontale     24 rotations, the label never tilts
//   appliques_dos_a_dos              THE reported case: NO MORE name on a wall-mounted object (the icon
//                                    is enough), side change included, name kept in the model
//   toutes_les_familles_de_texte     furniture, dimension, room, wall dimensions, guides,
//                                    measurements, cursor probe, peer cursor
//   export_png_et_impression         the master SVG and the printed page have no flipped text
import type { VerdictSonde } from "./_types.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

type CibleCDP = { type: string; webSocketDebuggerUrl: string };
type ValeurPage = ReturnType<typeof JSON.parse>;
type ReponseCDP = {
  id?: number;
  result?: { result?: { value?: unknown }; exceptionDetails?: { exception?: unknown }; [cle: string]: unknown };
  [cle: string]: unknown;
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const APP = process.argv[2] || path.join(__dirname, "..", "index.html");
const SEED = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "plan-reel-77.json"), "utf8"));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-textes-"));
const htmlPath = path.join(dir, "case.html");
fs.writeFileSync(htmlPath,
  `<!doctype html><html><head><meta charset="utf-8"><script>
window.__PLAN_TEST__=1;
try{ localStorage.clear(); localStorage.setItem("room-planner-v4", ${JSON.stringify(JSON.stringify(SEED))}); }catch(e){}
<\/script></head><body>` + fs.readFileSync(APP, "utf8") + "</body></html>",
  "utf8");

const profile = path.join(dir, "profile");
const chrome = spawn(CHROME, [
  "--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run",
  "--no-default-browser-check", "--hide-scrollbars",
  "--user-data-dir=" + profile, "--remote-debugging-port=0",
  "--window-size=1680,1000", "about:blank",
], { stdio: ["ignore", "pipe", "pipe"] });

const portFile = path.join(profile, "DevToolsActivePort");
async function waitPort() {
  for (let i = 0; i < 300; i++) {
    if (fs.existsSync(portFile)) {
      // The file can be LOCKED (EBUSY: Chrome still has it open), missing (ENOENT), or
      // truncated, especially since several Chrome instances start at once. We RETRY
      // until the timeout instead of throwing.
      let t: VerdictSonde[] = [];
      try { t = fs.readFileSync(portFile, "utf8").split("\n"); } catch { t = []; }
      if (t[0] && /^[0-9]+$/.test(t[0].trim())) return t[0].trim();
    }
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error("no DevToolsActivePort");
}
const port = await waitPort();
const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as CibleCDP[];
const page = list.find(t => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => (ws.onopen = r));

let msgId = 0;
const pending = new Map<number, (message: ReponseCDP) => void>();
ws.onmessage = ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); p(m); }
};
function send(method: string, params?: Record<string, unknown>) {
  const id = ++msgId;
  return new Promise<ReponseCDP>(res => { pending.set(id, res); ws.send(JSON.stringify({ id, method, params: params || {} })); });
}
async function evaluate(expr: string): Promise<ValeurPage> {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  const d = r.result || {};
  if (d.exceptionDetails) throw new Error("EVAL: " + JSON.stringify(d.exceptionDetails.exception || d.exceptionDetails));
  return d.result ? d.result.value : undefined;
}
const J = async (expr: string) => JSON.parse(await evaluate(`JSON.stringify(${expr})`));
const pause = (ms: number) => new Promise(r => setTimeout(r, ms));
await send("Page.enable");
await send("Runtime.enable");

async function reload() {
  await send("Page.navigate", { url: "file:///" + htmlPath.replace(/\\/g, "/") });
  for (let i = 0; i < 200; i++) {
    let st = null;
    try { st = await evaluate("document.readyState + '|' + (window.__plan ? 1 : 0)"); } catch (_) {}
    if (st === "complete|1") break;
    await pause(50);
  }
  await pause(350);
  await evaluate("__plan.fitView(); true");
  await pause(150);
}

// ---- micro-harness -----------------------------------------------------------------------------
const results: VerdictSonde[] = [];
let cur: VerdictSonde = null;
function ok(cond: unknown, msg?: string) { if (!cond) cur.fails.push(msg); return !!cond; }
async function test(name: string, fn: (...args: VerdictSonde[]) => VerdictSonde | Promise<VerdictSonde>) {
  cur = { name, fails: [] };
  await reload();
  try { await fn(); } catch (e) { cur.fails.push("EXCEPTION: " + (e && e.stack || e)); }
  const jsErr = await evaluate(`JSON.stringify((JSON.parse(localStorage.getItem("plan-errors")||"[]")||[]).map(function(e){return e&&e.msg}))`);
  if (jsErr && jsErr !== "[]") cur.fails.push("erreurs JS: " + jsErr);
  results.push(cur);
  console.log(`  ${cur.fails.length ? "FAIL " : "ok   "} ${name}`);
  cur.fails.forEach((f: VerdictSonde) => console.log("        - " + f));
}

// All the plan's texts with their SCREEN angle, and the ones that are unreadable.
const textes = () => J(`__plan.textesDuPlan()`);
const envers = async () => (await textes()).filter((t: VerdictSonde) => t.envers);
// The screen angle of a text whose content starts with `debut`.
const angleDe = async (debut: VerdictSonde) => {
  const t = (await textes()).filter((x: VerdictSonde) => x.txt.indexOf(debut) === 0)[0];
  return t ? t.ang : null;
};
// The range allowed for texts drawn in screen space: [-90, +90[.
const dansLaPlage = (a: VerdictSonde) => a != null && a >= -90 && a < 90;
// A furniture name, meanwhile, is only allowed ONE value.
const horizontal = (a: VerdictSonde) => a != null && Math.abs(a) < 0.5;

// =============================================================================
//  1. regle_pure_et_sans_hysteresis
// =============================================================================
// The sweep of the two old hinges (90 and 270) is kept: that's where the previous
// rule used to flip, so that's where a leftover half-turn would show. The criterion, though, has
// changed: no more sequence of angles to compare between both directions, no more flip to count, we
// expect ZERO at every step, going up as well as down. A rule with no flip cannot
// flicker, and a name that stays flat no longer has a reading direction to choose.
await test("regle_pure_et_sans_hysteresis", async () => {
  ok(await evaluate(`String(__plan.setLabelSpin(null, 123))`) === "0",
    "setLabelSpin sans enveloppe ne doit rien casser et rendre 0");

  // the real object, repainted at every step, in both directions
  const id = await evaluate(`(function(){var p=__plan.plan.pieces[0]; p.name="Repere"; return String(p.id);})()`);
  const lire = async (a: VerdictSonde) => {
    await evaluate(`(function(){var p=__plan.pieceById(${JSON.stringify(id)}); p.rot=${a}; __plan.render(); return 1;})()`);
    return J(`(function(){var m=new DOMMatrix(), n=document.querySelector('.piece[data-id="'+CSS.escape(${JSON.stringify(id)})+'"]').querySelector(".plabel");
      while(n && n!==document.body){ var t=getComputedStyle(n).transform;
        if(t && t!=="none") m=new DOMMatrix(t).multiply(m); n=n.parentElement; }
      var a=Math.atan2(m.b,m.a)*180/Math.PI; return Math.round((((a%360)+540)%360-180)*10)/10;})()`);
  };
  for (const centre of [90, 270]) {
    const monte = [], descend = [];
    for (let a = centre - 6; a <= centre + 6; a++) monte.push(await lire(a));
    for (let a = centre + 6; a >= centre - 6; a--) descend.unshift(await lire(a));
    ok(JSON.stringify(monte) === JSON.stringify(descend),
      `charnière ${centre}° : la suite d'angles diffère selon le SENS de rotation (clignotement)\n            monte=${JSON.stringify(monte)}\n            descend=${JSON.stringify(descend)}`);
    ok(monte.every(horizontal), `charnière ${centre}° : l'étiquette s'incline, angles mesurés ${JSON.stringify(monte)}`);
  }
});

// =============================================================================
//  2. etiquette_meuble_toujours_horizontale
// =============================================================================
// A furniture's label does NOT follow its object: it stays upright in screen space, at any
// tilt. We verify it on 24 orientations, 15 degrees apart: the screen angle of the name AND
// that of the L x H dimension (which lives in the same wrapper) are zero, and the object's NODE,
// meanwhile, does keep its rotation: it's the text that gets straightened, never the geometry.
await test("etiquette_meuble_toujours_horizontale", async () => {
  const id = await evaluate(`(function(){var p=__plan.plan.pieces[0]; p.name="Repere"; return String(p.id);})()`);
  const mesures = [];
  for (let rot = 0; rot < 360; rot += 15) {
    const r = await J(`(function(){var p=__plan.pieceById(${JSON.stringify(id)});
      p.rot=${rot}; __plan.selReplace(p.id); __plan.render();
      var t=__plan.textesDuPlan().filter(function(x){return x.txt.indexOf("Repere")===0;});
      var d=__plan.textesDuPlan().filter(function(x){return x.sel===".pdim";});
      return {rot:${rot}, lab:t.length?t[0].ang:null, envers:t.length?t[0].envers:null,
              cote:d.length?d[0].ang:null};})()`);
    mesures.push(r);
  }
  mesures.forEach(m => {
    ok(m.lab != null, `rot ${m.rot}° : aucune étiquette rendue, rien n'est prouvé`);
    ok(m.envers === false, `rot ${m.rot}° : l'étiquette est à l'envers (angle écran ${m.lab}°)`);
    ok(horizontal(m.lab), `rot ${m.rot}° : l'étiquette est inclinée de ${m.lab}°, attendu 0°`);
    // the DIMENSION (L x H) lives in the same wrapper: it too is upright
    ok(m.cote == null || horizontal(m.cote),
      `rot ${m.rot}° : la cote affichée est inclinée de ${m.cote}°, attendu 0°`);
  });
  console.log("        angles d'étiquette mesurés : " + JSON.stringify(mesures.map(m => m.lab)));
  // and the object, meanwhile, has NOT moved: only the text straightens
  const geo = await J(`(function(){var p=__plan.pieceById(${JSON.stringify(id)});
    var el=document.querySelector('.piece[data-id="'+CSS.escape(String(p.id))+'"]');
    var m=new DOMMatrix(getComputedStyle(el).transform);
    return {rot:p.rot, elAng:Math.round(Math.atan2(m.b,m.a)*180/Math.PI)};})()`);
  ok(((geo.elAng % 360) + 360) % 360 === ((geo.rot % 360) + 360) % 360,
    `le NŒUD de l'objet doit garder sa rotation ${geo.rot}°, il est à ${geo.elAng}°`);
});

// =============================================================================
//  3. appliques_dos_a_dos
// =============================================================================
// THE originally reported case: two sconces at the same spot on the same wall, one per face, one of which
// displayed "Applique" upside down. THE ANSWER CHANGED IN NATURE. The name of a wall-mounted object (door,
// sliding door, window, sconce, outlet, RJ45) is no longer written on the plan at all: the icon
// already says what it is, and on the real plan a single facade carried four stacked labels.
// A text that does not exist cannot read upside down; this test therefore now verifies
// its ABSENCE, which is the only honest guarantee, and keeps what remains true: the two boxes are
// indeed back to back, and CHANGING THE FACE of an already-placed sconce (the gesture that produced
// the defect, through an HTML cache that carries neither `side` nor `rot`) still makes no
// flipped text appear anywhere on the plan.
// The NAME, meanwhile, stays in the MODEL: we verify it in place (this is a display we removed,
// not data).
await test("appliques_dos_a_dos", async () => {
  const mur = await J(`(function(){var w=__plan.plan.walls.filter(function(x){return !x.isOutline;})
    .sort(function(a,b){return Math.hypot(b.b[0]-b.a[0],b.b[1]-b.a[1])-Math.hypot(a.b[0]-a.a[0],a.b[1]-a.a[1]);})[0];
    return {id:String(w.id), cx:(w.a[0]+w.b[0])/2, cy:(w.a[1]+w.b[1])/2,
            nx:-(w.b[1]-w.a[1]), ny:(w.b[0]-w.a[0])};})()`);
  const L = Math.hypot(mur.nx, mur.ny) || 1;
  const ux = mur.nx / L, uy = mur.ny / L;
  const a = await J(`__plan.v5PlaceAt("sconce",${(mur.cx + ux * 7).toFixed(1)},${(mur.cy + uy * 7).toFixed(1)})`);
  const b = await J(`__plan.v5PlaceAt("sconce",${(mur.cx - ux * 7).toFixed(1)},${(mur.cy - uy * 7).toFixed(1)})`);
  ok(a && b, "les deux appliques doivent se poser sur le mur choisi");
  if (!a || !b) return;
  await evaluate(`(function(){var o=__plan.v5OpeningById(${JSON.stringify(b.id)});
    o.t0=__plan.v5OpeningById(${JSON.stringify(a.id)}).t0; __plan.render(); return 1;})()`);
  await pause(120);
  const lire = () => J(`[${JSON.stringify(a.id)},${JSON.stringify(b.id)}].map(function(id){
    var el=document.querySelector('.piece[data-op="1"][data-id="'+CSS.escape(id)+'"]');
    var o=__plan.v5OpeningById(id);
    var bx=__plan.v5OpeningBox(__plan.plan, o);
    return {id:id, side:o.side, nom:o.name||null, boxRot:Math.round(bx.rot),
            icone:!!(el&&el.querySelector(".picon")),
            textes:el?[...el.querySelectorAll(".plabel,.pdim")].map(function(t){return t.textContent;}):null};})`);
  const dos = await lire();
  ok(Math.abs(((dos[0].boxRot - dos[1].boxRot) % 360 + 360) % 360 - 180) < 1,
    `les deux appliques doivent être dos à dos (boîtes à 180°), elles sont à ${dos[0].boxRot}° et ${dos[1].boxRot}°`);
  dos.forEach((d: VerdictSonde) => {
    ok(d.icone, `applique face ${d.side} : sans son icône, il ne reste RIEN à l'écran`);
    ok(d.textes && d.textes.length === 0,
      `applique face ${d.side} : le plan ne doit plus porter son nom, il affiche ${JSON.stringify(d.textes)}`);
    ok(d.nom, `applique face ${d.side} : le nom doit rester dans le MODÈLE (il vaut ${JSON.stringify(d.nom)})`);
  });

  // the gesture that produced the defect: changing the face of an ALREADY-placed sconce
  await evaluate(`(function(){var o=__plan.v5OpeningById(${JSON.stringify(b.id)});
    o.side=o.side?0:1; __plan.render(); return 1;})()`);
  await pause(120);
  const apres = await lire();
  apres.forEach((d: VerdictSonde) => ok(d.textes.length === 0 && d.icone,
    `après changement de face : l'ouverture doit garder son icône et aucun texte (${JSON.stringify(d.textes)})`));
  ok((await envers()).length === 0, "aucun texte du plan ne doit être à l'envers après un changement de face");

  // NO opening on the real plan, whatever its type, carries text.
  const restes = await J(`(function(){var out=[];
    document.querySelectorAll('.piece[data-op="1"]').forEach(function(el){
      el.querySelectorAll(".plabel,.pdim").forEach(function(t){ out.push(t.textContent); }); });
    return out;})()`);
  ok(restes.length === 0, `${restes.length} étiquette(s) encore posée(s) sur des ouvertures : ` + JSON.stringify(restes.slice(0, 6)));
});

// =============================================================================
//  4. toutes_les_familles_de_texte
// =============================================================================
// The complete inventory, in ONE single frame: furniture name, L x H dimension, room name, wall dimensions,
// clearance guides, tape-measure chips, cursor-distance probe, a peer's cursor
// label. Each must be present (otherwise nothing is proven) and none must fall outside the
// readable range, whatever the tilt of the objects beneath them.
// OPENINGS no longer have a text family: their name is no longer written on the plan (js/54).
await test("toutes_les_familles_de_texte", async () => {
  // tilted furniture everywhere, so nothing is proven "by chance". The first one gets a
  // CHOSEN name: only those get written on the plan (js/12), without which the `.plabel` family
  // would not be rendered at all and this test would prove nothing about it.
  await evaluate(`(function(){ __plan.plan.pieces.forEach(function(p,i){ p.rot=(i*37)%360; });
    var p0=__plan.plan.pieces.slice().sort(function(a,b){
      return Math.min(b.w,b.h)-Math.min(a.w,a.h); })[0];
    p0.rot=0; p0.name="Repere";
    __plan.selReplace(String(p0.id)); __plan.render(); return 1;})()`);
  await evaluate(`__plan.montrerCotesMurs(); true`);
  const g = await evaluate(`String(__plan.montrerGuidesOuverture(String(__plan.plan.openings[0].id)))`);
  await evaluate(`__plan.montrerCurseurPair(400,400); true`);
  await evaluate(`__plan.setMeasureMode(true); true`);
  await evaluate(`(function(){var b=__plan.aptBBox();
    __plan.measureClickApt(b.minX+60, b.minY+60); __plan.measureClickApt(b.minX+260, b.minY+180); return 1;})()`);
  await evaluate(`(function(){var b=__plan.aptBBox(); __plan.drawCursorGuidesNow(b.minX+150, b.minY+150); return 1;})()`);
  await pause(200);

  const t = await textes();
  const parFamille: Record<string, number> = {};
  t.forEach((x: VerdictSonde) => { parFamille[x.sel] = (parFamille[x.sel] || 0) + 1; });
  const ATTENDU = [".plabel", ".pdim", ".ov-name", ".glab", ".v5dim", ".mchip", ".cgchip", ".pc-name"];
  ATTENDU.forEach(sel => ok(parFamille[sel] > 0,
    `la famille ${sel} n'est pas rendue : ce test ne prouverait rien sur elle (guides=${g})`));
  const mauvais = t.filter((x: VerdictSonde) => !dansLaPlage(x.ang));
  ok(mauvais.length === 0,
    `${mauvais.length} texte(s) hors de la plage lisible : ` + JSON.stringify(mauvais.slice(0, 6)));
  // The two families carried by a ROTATED object (furniture name, L x H dimension) are not allowed the
  // range: they must be exactly upright.
  const penchees = t.filter((x: VerdictSonde) => (x.sel === ".plabel" || x.sel === ".pdim") && !horizontal(x.ang));
  ok(penchees.length === 0,
    `${penchees.length} nom(s)/cote(s) de meuble inclinés : ` + JSON.stringify(penchees.slice(0, 6)));
  console.log("        familles mesurées : " + JSON.stringify(parFamille));
});

// =============================================================================
//  5. export_png_et_impression
// =============================================================================
// The export builds its OWN SVG: a correct screen and an upside-down sheet would be absurd.
// We measure the REAL screen angle of every <text> (getScreenCTM, hence the whole chain of groups),
// in the master SVG then in the print page, which reuses it.
await test("export_png_et_impression", async () => {
  // A CHOSEN name on the biggest furniture, tilted: the sheet now carries furniture names
  // (js/32), so at least one must be there for this test to prove anything about them.
  await evaluate(`(function(){ __plan.plan.pieces.forEach(function(p,i){ p.rot=(i*53)%360; });
    var p0=__plan.plan.pieces.slice().sort(function(a,b){
      return Math.min(b.w,b.h)-Math.min(a.w,a.h); })[0];
    p0.rot=90; p0.name="Repere";
    __plan.render(); return 1;})()`);
  const svg = await J(`(function(){
    var host=document.createElement("div");
    host.style.cssText="position:fixed;left:0;top:0;opacity:0;pointer-events:none";
    host.innerHTML=__plan.buildMasterSVG();
    document.body.appendChild(host);
    var out=[];
    host.querySelectorAll("text").forEach(function(t){
      var m=t.getScreenCTM(); if(!m) return;
      var a=Math.atan2(m.b,m.a)*180/Math.PI;
      out.push({txt:(t.textContent||"").slice(0,24), ang:Math.round((((a%360)+540)%360-180)*10)/10});
    });
    host.remove(); return out;})()`);
  ok(svg.length > 0, "le SVG maître doit contenir du texte (sinon ce test ne prouve rien)");
  ok(svg.some((t: VerdictSonde) => t.txt.indexOf("Repere") === 0),
    "le SVG maître doit porter le nom CHOISI d'un meuble : " + JSON.stringify(svg.map((t: VerdictSonde) => t.txt)));
  // ALL the sheet's text is upright: title, room names AND furniture names, even on
  // furniture placed upright.
  const svgMauvais = svg.filter((t: VerdictSonde) => !horizontal(t.ang));
  ok(svgMauvais.length === 0, "export PNG : texte(s) incliné(s) " + JSON.stringify(svgMauvais));

  const prn = await J(`(function(){ __plan.preparePrint();
    var out=[];
    document.querySelectorAll("#printPlan text").forEach(function(t){
      var m=t.getScreenCTM(); if(!m) return;
      var a=Math.atan2(m.b,m.a)*180/Math.PI;
      out.push({txt:(t.textContent||"").slice(0,24), ang:Math.round((((a%360)+540)%360-180)*10)/10});
    });
    var tbl=document.querySelectorAll("#printFurni td").length;
    __plan.clearPrint();
    return {out:out, tbl:tbl};})()`);
  ok(prn.out.length > 0, "la page imprimée doit contenir du texte");
  ok(prn.tbl > 0, "la page imprimée doit porter la liste du mobilier (texte HTML, donc droit)");
  ok(prn.out.some((t: VerdictSonde) => t.txt.indexOf("Repere") === 0), "la page imprimée doit porter le nom du meuble");
  const prnMauvais = prn.out.filter((t: VerdictSonde) => !horizontal(t.ang));
  ok(prnMauvais.length === 0, "impression : texte(s) incliné(s) " + JSON.stringify(prnMauvais));

  // Shape guardrail: the only ROTATED group in the master SVG is the icons' one. A <text> landing
  // there would inherit the object's rotation and read crooked.
  const dansRotation = await evaluate(`(function(){
    var host=document.createElement("div"); host.innerHTML=__plan.buildMasterSVG();
    document.body.appendChild(host);
    var n=0;
    host.querySelectorAll("text").forEach(function(t){
      var p=t.parentElement;
      while(p && p.tagName!=="svg"){ var tr=p.getAttribute&&p.getAttribute("transform");
        if(tr && /rotate\\(/.test(tr)) n++; p=p.parentElement; }
    });
    host.remove(); return String(n);})()`);
  ok(dansRotation === "0", `${dansRotation} <text> vit dans un groupe tourné du SVG maître`);
});

// ---- verdict -----------------------------------------------------------------------------------
const bad = results.filter(r => r.fails.length);
console.log("");
if (bad.length) {
  console.log(`FAILURES ${bad.length}/${results.length}:`);
  bad.forEach(r => r.fails.forEach((f: VerdictSonde) => console.log(`  - ${r.name}: ${f}`)));
} else {
  console.log(`OK ${results.length}/${results.length}`);
}
ws.close(); chrome.kill();
try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
process.exit(bad.length ? 1 : 0);
