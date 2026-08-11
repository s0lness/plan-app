#!/usr/bin/env node
// =============================================================================
//  "VIDEO PROJECTOR" SUITE — NO BROWSER (the geometry is PURE)
// =============================================================================
// Usage request: "see the projection throw to know where to place it, be able to pair it to a
// screen, move it back/forward, and know if the minimum distance is respected, including in ultra
// short throw, set right in front of the screen".
//
// THE CHOICE THAT STRUCTURES EVERYTHING: the distance is NOT stored, it is a RESULT. What we store
// is the projection RATIO (`tr`, x100), the number from the spec sheet. A stored "projection
// distance" would have been unable to say either what happens when you move the device back, or what
// an ultra short throw is.
//
//   node tests/projection.ts
//
//   l_image_grandit_avec_la_distance        width = distance / ratio, the base law
//   l_ultra_courte_focale_tient_de_pres     0.25: 120 cm of image at 30 cm from the wall
//   le_faisceau_part_de_l_objectif          not from the center of the box
//   la_direction_suit_la_rotation           the four orientations
//   l_ecran_derriere_ne_compte_pas          we don't project backward
//   le_decalage_lateral_ne_fausse_pas       distance is measured along the aim axis
//   trop_pres_ne_se_devine_pas              without `dmin` set, no verdict
//   le_verdict_compare_a_l_ecran            wider / narrower / nothing to say
import type { DonneeDynamique } from "./_types.ts";
import {
  TR_DEFAUT, directionTir, distanceAEcran, largeurImage, polygoneFaisceau, projection,
  sortieObjectif, verdictProjection,
} from "../src/ts/modele/projection.ts";

let ok = 0, ko = 0;
const rates: DonneeDynamique[] = [];
function test(nom: string, fn: (...args: DonneeDynamique[]) => DonneeDynamique | Promise<DonneeDynamique>) {
  const fails = [];
  try { fn((c: DonneeDynamique, m: DonneeDynamique) => { if (!c) fails.push(m); }); } catch (e) { fails.push("EXCEPTION: " + (e && e.stack || e)); }
  if (fails.length) { ko++; rates.push(nom); } else ok++;
  console.log(`  ${fails.length ? "FAIL " : "ok   "} ${nom}`);
  fails.forEach(f => console.log("        - " + f));
}
const P = (o: DonneeDynamique) => Object.assign({ x: 0, y: 0, w: 35, h: 30, rot: 0 }, o);
const E = (o: DonneeDynamique) => Object.assign({ x: 0, y: 0, w: 200, h: 10, rot: 0 }, o);
const pres = (a: DonneeDynamique, b: DonneeDynamique, tol = 0.01) => Math.abs(a - b) <= tol;

// ---------------------------------------------------------------------------------------------
test("l_image_grandit_avec_la_distance", (a: DonneeDynamique) => {
  // Ratio of 1.50: at 300 cm you get 200 cm of image. It's the law, and it's linear.
  a(pres(largeurImage(300, 150), 200), `300 ÷ 1,50 = 200, vu ${largeurImage(300, 150)}`);
  a(pres(largeurImage(600, 150), 400), "le double de distance donne le double d'image");
  a(pres(largeurImage(300, undefined), 300 / (TR_DEFAUT / 100)),
    "sans rapport saisi, on prend le défaut, on n'invente pas");
});

test("l_ultra_courte_focale_tient_de_pres", (a: DonneeDynamique) => {
  // This is the case the request explicitly cites, and the one a "stored distance" cannot
  // express: ratio of 0.25, 30 cm from the wall, 120 cm of image.
  a(pres(largeurImage(30, 25), 120), `UST : 30 ÷ 0,25 = 120, vu ${largeurImage(30, 25)}`);
  const pr = projection(P({ tr: 25, dmin: 0 }), E({ x: -80, y: 60 }));
  a(pr.versEcran, "l'écran est bien devant");
  a(!pr.tropPres, "sans distance minimale renseignée, un UST n'est jamais « trop près »");
});

test("le_faisceau_part_de_l_objectif", (a: DonneeDynamique) => {
  // The lens is at the middle of the FRONT face, not the center of the box: at rot=0, y = bottom.
  const p = P({ x: 100, y: 200 });
  const s = sortieObjectif(p);
  a(pres(s.ox, 100 + 35 / 2), `x = centre, vu ${s.ox}`);
  a(pres(s.oy, 200 + 30), `y = face avant (y + h), vu ${s.oy}`);
  const poly = polygoneFaisceau(p, null);
  a(poly.length === 4, `le faisceau est un quadrilatère, vu ${poly.length} points`);
  a(pres(poly[0][1], s.oy, 0.5) && pres(poly[1][1], s.oy, 0.5),
    "ses deux premiers points sont à l'objectif");
});

test("la_direction_suit_la_rotation", (a: DonneeDynamique) => {
  const d0 = directionTir(0), d90 = directionTir(90), d180 = directionTir(180), d270 = directionTir(270);
  a(pres(d0.ux, 0) && pres(d0.uy, 1), `0° tire vers +y, vu ${JSON.stringify(d0)}`);
  a(pres(d90.ux, -1) && pres(d90.uy, 0), `90° tire vers -x, vu ${JSON.stringify(d90)}`);
  a(pres(d180.ux, 0) && pres(d180.uy, -1), `180° tire vers -y, vu ${JSON.stringify(d180)}`);
  a(pres(d270.ux, 1) && pres(d270.uy, 0), `270° tire vers +x, vu ${JSON.stringify(d270)}`);
});

test("l_ecran_derriere_ne_compte_pas", (a: DonneeDynamique) => {
  // A projector does not project backward: a screen behind it is not "at -300 cm", it
  // is not paired at all, and the beam falls back to its free throw.
  const p = P({ x: 0, y: 500 });
  a(distanceAEcran(p, E({ x: 0, y: 100 })) === null, "écran derrière -> pas de distance");
  const pr = projection(p, E({ x: 0, y: 100 }));
  a(!pr.versEcran, "et pas de verdict d'écran");
  a(pr.distance > 0, "mais un faisceau quand même, sur la portée libre");
});

test("le_decalage_lateral_ne_fausse_pas", (a: DonneeDynamique) => {
  // The projector is not always straight on. The OPTICAL distance is the projection onto the aim
  // axis: a lateral offset must NOT lengthen it (which is what a straight-line distance would do).
  const p = P({ x: 0, y: 0 });
  const droit = distanceAEcran(p, E({ x: 0, y: 330 }));
  const decale = distanceAEcran(p, E({ x: 400, y: 330 }));
  a(pres(droit, decale), `même distance optique malgré 400 cm de décalage, ${droit} vs ${decale}`);
});

test("trop_pres_ne_se_devine_pas", (a: DonneeDynamique) => {
  const ecran = E({ x: 0, y: 100 });
  a(!projection(P({ tr: 150 }), ecran).tropPres,
    "sans `dmin`, on ne prétend pas savoir si c'est trop près");
  const p = P({ tr: 150, dmin: 200 });
  a(projection(p, ecran).tropPres, "avec `dmin` = 200 et un écran à ~70 cm, c'est trop près");
  a(verdictProjection(projection(p, ecran)) === "Too close to focus",
    "et ça se DIT, ce n'est pas juste un booléen");
});

test("le_verdict_compare_a_l_ecran", (a: DonneeDynamique) => {
  // At 300 cm with a ratio of 1.50, the image is 200 cm.
  const p = P({ x: 0, y: 0, tr: 150 });
  const juste = projection(p, E({ x: 0, y: 330, w: 200 }));
  a(verdictProjection(juste) === null,
    `200 d'image sur 200 d'écran : rien à dire, vu ${JSON.stringify(verdictProjection(juste))}`);
  const etroit = projection(p, E({ x: 0, y: 330, w: 300 }));
  a(/narrower/.test(String(verdictProjection(etroit))),
    `image plus étroite que l'écran, vu ${verdictProjection(etroit)}`);
  const large = projection(p, E({ x: 0, y: 330, w: 120 }));
  a(/wider/.test(String(verdictProjection(large))),
    `image plus large que l'écran, vu ${verdictProjection(large)}`);
});

// ---------------------------------------------------------------------------------------------
console.log(`\n${ko ? `FAILURES ${ko}/${ok + ko}` : `OK ${ok}/${ok}`}`);
rates.forEach(n => console.log("  FAIL " + n));
process.exit(ko ? 1 : 0);
