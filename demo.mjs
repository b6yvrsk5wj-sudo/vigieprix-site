#!/usr/bin/env node
// demo.mjs — regenere demo.html avec un vrai releve de prix, horodate.
//
// Tourne tout seul via .github/workflows/demo.yml. Le but : montrer a un visiteur
// des prix qui bougent vraiment, pas une capture d'ecran figee.
//
// Les boutiques sont ANONYMISEES sur la page publique : nommer des commerçants
// reels dans un argumentaire commercial releve de la publicite comparative,
// qui est encadree en France. Les chiffres, eux, sont bruts.

import { writeFileSync } from 'node:fs';

const BOUTIQUES = [
  { alias: 'Boutique A', url: 'https://www.leurredelapeche.fr/13405-moulinet-spinning-shimano-stradic-fm.html' },
  { alias: 'Boutique B', url: 'https://pechepromo.fr/t/moulinets/moulinet-spinning-shimano-stradic-fm' },
];
const PRODUIT = 'Moulinet spinning Shimano Stradic FM';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const pause = ms => new Promise(r => setTimeout(r, ms));

async function recuperer(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'fr-FR,fr;q=0.9' }, signal: ctrl.signal, redirect: 'follow' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.text();
  } finally { clearTimeout(t); }
}

function versNombre(v) {
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? v : null;
  if (typeof v !== 'string') return null;
  let s = v.replace(/[\s  ]/g, '');
  const vg = s.lastIndexOf(','), pt = s.lastIndexOf('.');
  if (vg > -1 && pt > -1) s = vg > pt ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  else if (vg > -1) s = (s.length - vg - 1) <= 2 ? s.replace(',', '.') : s.replace(/,/g, '');
  const n = parseFloat(s.replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function* tousLesObjets(x) {
  if (Array.isArray(x)) { for (const e of x) yield* tousLesObjets(e); return; }
  if (x && typeof x === 'object') { yield x; for (const v of Object.values(x)) yield* tousLesObjets(v); }
}

// Une page produit cache souvent quinze declinaisons a des prix differents.
function extraireVariantes(html) {
  const out = [];
  const vues = new Set();
  for (const b of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    let data;
    try { data = JSON.parse(b[1].trim()); } catch { continue; }
    for (const o of tousLesObjets(data)) {
      if (String(o['@type'] || '') !== 'Product') continue;
      const nomProduit = typeof o.name === 'string' ? o.name : '';
      const offres = Array.isArray(o.offers) ? o.offers : (o.offers ? [o.offers] : []);
      for (const off of offres) {
        if (!off || typeof off !== 'object') continue;
        const prix = versNombre(off.price ?? off.lowPrice);
        if (prix === null) continue;
        const libelle = (typeof off.name === 'string' && off.name) || nomProduit;
        const cle = libelle + '|' + prix;
        if (vues.has(cle)) continue;
        vues.add(cle);
        out.push({ libelle, prix });
      }
    }
  }
  return out;
}

// "Poids 185g Taille C3000 XG Ratio 6.4:1" -> C3000XG
// Chez Shimano, ce code designe le meme moulinet chez tous les revendeurs.
const SUFFIXES = 'SHG|MHG|XG|HG|PG|SW|S';
function cleTaille(libelle) {
  if (!libelle) return null;
  let s = libelle.toUpperCase()
    .replace(/[  ]/g, ' ')
    .replace(/\bPOIDS\s*\d+\s*G\b/g, ' ')
    .replace(/\bRATIO\s*[\d.,:]+/g, ' ')
    .replace(/\bR[EÉ]CUP[^\s]*\s*\d+\s*CM/g, ' ')
    .replace(/\bFREIN\b[\s\S]*$/g, ' ')
    .replace(/\b\d+\s*(?:G|GR|CM|MM|KG)\b/g, ' ');
  const t = s.match(/TAILLE\s+([A-Z0-9 ]{2,20})/);
  if (t) s = t[1];
  const m = s.match(new RegExp('\\b(C?\\d{3,4})\\s*(' + SUFFIXES + ')?\\b'));
  return m ? m[1] + (m[2] || '') : null;
}

const eur = n => n.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
const echapper = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ------------------------------------------------------------------ releve
const releves = [];
for (const b of BOUTIQUES) {
  try {
    const html = await recuperer(b.url);
    const parTaille = new Map();
    for (const v of extraireVariantes(html)) {
      const cle = cleTaille(v.libelle);
      if (!cle) continue;
      const deja = parTaille.get(cle);
      if (!deja || v.prix < deja) parTaille.set(cle, v.prix);
    }
    releves.push({ alias: b.alias, parTaille });
    console.log(b.alias + ' : ' + parTaille.size + ' taille(s)');
  } catch (e) {
    console.log(b.alias + ' : echec (' + e.message + ')');
  }
  await pause(1500);
}

const exploitables = releves.filter(r => r.parTaille.size > 0);
if (exploitables.length < 2) {
  console.log('Moins de deux boutiques lisibles : la page n est pas regeneree.');
  process.exit(0);
}

const communes = [...new Set(exploitables.flatMap(r => [...r.parTaille.keys()]))]
  .filter(t => exploitables.every(r => r.parTaille.has(t)))
  .sort();

const lignes = communes.map(t => {
  const prix = exploitables.map(r => r.parTaille.get(t));
  const min = Math.min(...prix), max = Math.max(...prix);
  const ecart = min > 0 ? ((max - min) / min) * 100 : 0;
  return { taille: t, prix, ecart, plusCherIndex: prix.indexOf(max) };
});

const maintenant = new Date().toLocaleString('fr-FR', {
  timeZone: 'Europe/Paris', day: '2-digit', month: 'long', year: 'numeric',
  hour: '2-digit', minute: '2-digit',
});
const ecartMoyen = lignes.length ? lignes.reduce((s, l) => s + l.ecart, 0) / lignes.length : 0;

// ------------------------------------------------------------------- page
const page = `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Relevé en direct — VigiePrix</title>
<meta name="description" content="Un relevé de prix réel, régénéré automatiquement plusieurs fois par jour.">
<link rel="icon" href="/logo-carre.svg" type="image/svg+xml">
<style>
  :root{--nuit:#0d1b33;--encre:#12213a;--gris:#5a6b85;--gris-clair:#8496b3;--trait:#e2e8f2;
        --doux:#f5f8fd;--accent:#1b4fd8;--accent-clair:#4b7bf5;--vert:#0f7a4a;--rouge:#c2401f}
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#fff;color:var(--encre);
       font:16px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
       -webkit-font-smoothing:antialiased}
  .page{max-width:760px;margin:0 auto;padding:0 24px}
  a{color:var(--accent)}
  .barre{background:var(--nuit);padding:18px 0}
  .barre .page{display:flex;justify-content:space-between;align-items:center}
  .marque{font-size:19px;font-weight:800;color:#fff;letter-spacing:-.3px;text-decoration:none}
  .marque span{color:var(--accent-clair)}
  .veille{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--gris-clair)}
  .point{width:8px;height:8px;border-radius:50%;background:#3ecf7a;animation:pulse 2.4s infinite}
  @keyframes pulse{0%{box-shadow:0 0 0 0 rgba(62,207,122,.6)}70%{box-shadow:0 0 0 9px rgba(62,207,122,0)}100%{box-shadow:0 0 0 0 rgba(62,207,122,0)}}
  h1{font-size:32px;letter-spacing:-.6px;margin:44px 0 14px;line-height:1.2}
  .chapo{color:var(--gris);margin-bottom:8px}
  .horodate{display:inline-block;background:var(--doux);border:1px solid var(--trait);
            border-radius:8px;padding:8px 13px;font-size:14px;color:var(--gris);margin:14px 0 30px}
  .horodate b{color:var(--encre)}
  table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums;font-size:15px}
  th,td{text-align:left;padding:10px 12px;border-bottom:1px solid var(--trait);white-space:nowrap}
  th{font-size:11.5px;text-transform:uppercase;letter-spacing:.5px;color:var(--gris);font-weight:700}
  td.n{text-align:right;font-weight:600}
  .cher{color:var(--rouge)}
  .ecart{color:var(--gris);font-weight:600}
  .tableau{overflow-x:auto}
  .bilan{background:var(--doux);border:1px solid var(--trait);border-radius:10px;padding:18px 20px;margin:28px 0}
  .bilan p{font-size:15px;color:var(--gris)}
  .bilan strong{color:var(--encre)}
  .retour{margin:36px 0 60px;font-size:15px}
  footer{padding:26px 0 50px;font-size:13px;color:var(--gris);border-top:1px solid var(--trait)}
</style>
</head>
<body>

<div class="barre">
  <div class="page">
    <a class="marque" href="/">Vigie<span>Prix</span></a>
    <div class="veille"><span class="point"></span> relevé automatique</div>
  </div>
</div>

<div class="page">
  <h1>Relevé en direct</h1>
  <p class="chapo">Cette page n'est pas une capture d'écran. Elle est régénérée automatiquement
     par l'outil, plusieurs fois par jour, à partir des prix réellement affichés en ligne.</p>
  <div class="horodate">Dernier relevé : <b>${echapper(maintenant)}</b></div>

  <p class="chapo">Produit suivi : <strong>${echapper(PRODUIT)}</strong> —
     ${lignes.length} taille${lignes.length > 1 ? 's' : ''} présente${lignes.length > 1 ? 's' : ''}
     chez les deux revendeurs. Les noms des boutiques sont masqués&nbsp;; les prix, eux, sont bruts.</p>

  <div class="tableau">
    <table>
      <thead>
        <tr><th>Taille</th>${exploitables.map(r => '<th class="n">' + echapper(r.alias) + '</th>').join('')}<th class="n">Écart</th></tr>
      </thead>
      <tbody>
        ${lignes.map(l => '<tr><td>' + echapper(l.taille) + '</td>'
          + l.prix.map((p, i) => '<td class="n' + (i === l.plusCherIndex && l.ecart > 0.05 ? ' cher' : '') + '">' + eur(p) + '</td>').join('')
          + '<td class="n ecart">' + (l.ecart < 0.05 ? '—' : '+' + l.ecart.toFixed(1) + ' %') + '</td></tr>').join('\n        ')}
      </tbody>
    </table>
  </div>

  <div class="bilan">
    <p>Sur ces <strong>${lignes.length} références strictement identiques</strong>, l'écart moyen
       est de <strong>${ecartMoyen.toFixed(1)} %</strong>. Chaque taille est appariée une par une :
       comparer une taille 1000 avec une taille 2500 donnerait un écart qui ne veut rien dire.</p>
  </div>

  <p class="retour">C'est exactement ce que je mets en place pour votre boutique.
     <a href="/">Revenir à l'accueil</a> ou
     <a href="mailto:baptiste@vigieprix.fr">demander un relevé gratuit</a>.</p>

  <footer>
    <p>VigiePrix — Baptiste Hollertt · baptiste@vigieprix.fr</p>
  </footer>
</div>

</body>
</html>
`;

writeFileSync('demo.html', page, 'utf8');
console.log('demo.html regenere : ' + lignes.length + ' taille(s) comparee(s), ecart moyen ' + ecartMoyen.toFixed(1) + ' %');
