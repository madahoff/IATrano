// Corpus de test reproductible pour la bibliothèque documentaire : un « manuel technique » de 400 pages
// (10 chapitres × 40 pages) généré de façon déterministe, avec des faits uniques placés à des pages connues
// (vérité terrain pour mesurer précision et rappel), deux méthodes décrites dans des chapitres différents,
// une contradiction volontaire et, en option, des pages numérisées (image seule, sans couche texte).
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildPdf, type PdfPage } from "./pdf-writer";

function prng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const SUBJECTS = ["le capteur", "la sonde", "le module de contrôle", "l'opérateur", "le banc d'essai", "la chaîne de mesure", "le réseau de terrain", "l'équipe de maintenance"];
const VERBS = ["surveille", "enregistre", "compare", "transmet", "ajuste", "vérifie", "consigne", "analyse"];
const OBJECTS = ["la température ambiante", "les écarts de tension", "le débit du circuit", "la pression résiduelle", "les alarmes actives", "l'historique des interventions", "les valeurs de référence", "la consommation électrique"];
const TAILS = ["avant chaque cycle de production.", "selon le protocole interne.", "lorsque l'installation est à l'arrêt.", "au moins une fois par semaine.", "pour garantir la traçabilité.", "en cas de dérive constatée.", "dans le respect des tolérances.", "sous la supervision du responsable qualité."];

export const CHAPTERS = [
  "Présentation générale",
  "Méthodes de calibration",
  "Seuils et alarmes",
  "Maintenance préventive",
  "Sécurité électrique",
  "Gestion des données",
  "Seuils révisés",
  "Méthodes de diagnostic",
  "Études de cas",
  "Annexes techniques",
];

/** Faits uniques (vérité terrain) : question → page attendue. */
export const NEEDLES = [
  { page: 3, token: "ZEPHYR-117", sentence: "Le code d'accès du coffret principal est ZEPHYR-117 et il est renouvelé chaque trimestre.", query: "code d'accès du coffret principal" },
  { page: 57, token: "ORCHIDEE-42", sentence: "La référence du lubrifiant homologué pour les paliers est ORCHIDEE-42.", query: "lubrifiant homologué paliers" },
  { page: 133, token: "Kestrel", sentence: "Le fournisseur retenu pour les relais de sécurité est la société Kestrel Industries.", query: "fournisseur des relais de sécurité" },
  { page: 200, token: "MERIDIAN-9", sentence: "La sauvegarde quotidienne des journaux est envoyée vers le serveur MERIDIAN-9 à deux heures du matin.", query: "serveur de sauvegarde des journaux" },
  { page: 288, token: "18 minutes", sentence: "Le temps moyen de rétablissement observé après une coupure est de 18 minutes.", query: "temps moyen de rétablissement après une coupure" },
  { page: 341, token: "Saint-Nazaire", sentence: "Le site pilote de l'étude de cas numéro quatre est situé à Saint-Nazaire.", query: "localisation du site pilote de l'étude de cas" },
  { page: 398, token: "VERMILLON", sentence: "Le schéma de câblage de référence porte le nom de code VERMILLON dans les annexes.", query: "nom de code du schéma de câblage de référence" },
];

/** Méthodes décrites explicitement (chapitres 2 et 8) et définitions contradictoires (chapitres 3 et 7). */
export const METHOD_PAGES = { calibration: 45, diagnostic: 285 };
export const CONTRADICTION_PAGES = { first: 85, second: 245 };

function sentence(r: () => number) {
  const pick = <T>(a: T[]) => a[Math.floor(r() * a.length)];
  return `${pick(SUBJECTS).replace(/^./, (c) => c.toUpperCase())} ${pick(VERBS)} ${pick(OBJECTS)} ${pick(TAILS)}`;
}

function wrap(text: string, width = 92): string[] {
  const out: string[] = [];
  let line = "";
  for (const w of text.split(" ")) {
    if ((line + " " + w).trim().length > width) {
      out.push(line.trim());
      line = w;
    } else line += ` ${w}`;
  }
  if (line.trim()) out.push(line.trim());
  return out;
}

export function manualPageLines(n: number, r: () => number): Array<string | { text: string; size?: number; bold?: boolean }> {
  const chapter = Math.floor((n - 1) / 40);
  const inChapter = (n - 1) % 40;
  const lines: Array<string | { text: string; size?: number; bold?: boolean }> = [{ text: "MANUEL D'EXPLOITATION — INSTALLATION DE TEST", size: 8 }];
  if (inChapter === 0) lines.push("", { text: `Chapitre ${chapter + 1} ${CHAPTERS[chapter]}`, size: 16, bold: true });
  if (inChapter % 10 === 0) lines.push("", { text: `${chapter + 1}.${inChapter / 10 + 1} Partie ${inChapter / 10 + 1} du chapitre ${chapter + 1}`, size: 12, bold: true });
  const body: string[] = [];
  for (let p = 0; p < 4; p++) body.push(Array.from({ length: 4 }, () => sentence(r)).join(" "));
  const needle = NEEDLES.find((x) => x.page === n);
  if (needle) body.splice(1, 0, needle.sentence);
  if (n === METHOD_PAGES.calibration) {
    body.unshift(
      "Méthode de calibration en trois points : l'auteur recommande cette méthode pour tous les capteurs de pression.",
      "Étape 1 : isoler le capteur et le raccorder au banc étalon.",
      "Étape 2 : appliquer successivement trois pressions de référence et relever les écarts.",
      "Étape 3 : corriger le gain puis consigner le certificat dans le registre.",
    );
  }
  if (n === METHOD_PAGES.diagnostic) {
    body.unshift(
      "Méthode de diagnostic par élimination : elle s'applique lorsqu'une alarme persiste malgré la calibration.",
      "Étape 1 : vérifier l'alimentation du module de contrôle.",
      "Étape 2 : remplacer la sonde par une sonde de référence.",
      "Étape 3 : comparer les mesures et isoler le composant défaillant.",
    );
  }
  if (n === CONTRADICTION_PAGES.first) body.unshift("Définition : le seuil critique est fixé à 40 volts pour l'ensemble des armoires.");
  if (n === CONTRADICTION_PAGES.second) body.unshift("Définition : le seuil critique est fixé à 55 volts depuis la révision des normes.");
  for (const para of body) {
    lines.push("");
    lines.push(...wrap(para));
  }
  lines.push("", { text: `${n}`, size: 8 });
  return lines;
}

export function buildManualPdf(pages = 400, opts: { scannedPages?: number[] } = {}): Buffer {
  const r = prng(42);
  const list: PdfPage[] = [];
  for (let n = 1; n <= pages; n++) {
    const lines = manualPageLines(n, r);
    list.push(opts.scannedPages?.includes(n) ? scannedPage(lines) : { kind: "text", lines });
  }
  return buildPdf(list, { title: "Manuel d'exploitation", author: "Équipe de test" });
}

/** Page « numérisée » : rendu image (JPEG niveaux de gris) d'une page de texte, sans couche texte. */
export function scannedPage(lines: Array<string | { text: string; size?: number; bold?: boolean }>): PdfPage {
  const dir = mkdtempSync(path.join(tmpdir(), "iatrano-scan-"));
  try {
    writeFileSync(path.join(dir, "p.pdf"), buildPdf([{ kind: "text", lines }]));
    execFileSync("pdftoppm", ["-r", "150", "-gray", "-jpeg", "-singlefile", path.join(dir, "p.pdf"), path.join(dir, "p")]);
    const jpeg = readFileSync(path.join(dir, "p.jpg"));
    return { kind: "image", jpeg, ...jpegSize(jpeg) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Dimensions lues dans le segment SOF, en parcourant les marqueurs (un octet 0xFFC0 peut figurer ailleurs). */
function jpegSize(jpeg: Buffer) {
  let i = 2;
  while (i < jpeg.length) {
    const marker = jpeg[i + 1];
    const len = jpeg.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { height: jpeg.readUInt16BE(i + 5), width: jpeg.readUInt16BE(i + 7), components: (jpeg[i + 9] === 3 ? 3 : 1) as 1 | 3 };
    i += 2 + len;
  }
  throw new Error("JPEG sans segment SOF");
}

/** Image PNG d'un texte (tableau ou schéma annoté) : rendu d'une page PDF. */
export function textImagePng(lines: string[]): Buffer {
  const dir = mkdtempSync(path.join(tmpdir(), "iatrano-img-"));
  try {
    writeFileSync(path.join(dir, "p.pdf"), buildPdf([{ kind: "text", lines: lines.map((t) => ({ text: t, size: 14 })) }]));
    execFileSync("pdftoppm", ["-r", "120", "-gray", "-png", "-singlefile", "-x", "0", "-y", "0", "-W", "992", "-H", "500", path.join(dir, "p.pdf"), path.join(dir, "p")]);
    return readFileSync(path.join(dir, "p.png"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Vidéo de 20 s : trois plans de couleur (changements de scène) et une piste audio. */
export function buildVideo(): Buffer {
  const dir = mkdtempSync(path.join(tmpdir(), "iatrano-vid-"));
  try {
    const out = path.join(dir, "v.mp4");
    execFileSync("ffmpeg", [
      "-nostdin", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "color=c=red:s=320x240:d=7:r=10",
      "-f", "lavfi", "-i", "color=c=blue:s=320x240:d=7:r=10",
      "-f", "lavfi", "-i", "color=c=green:s=320x240:d=6:r=10",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=20",
      "-filter_complex", "[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]",
      "-map", "[v]", "-map", "3:a", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", out,
    ]);
    return readFileSync(out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
