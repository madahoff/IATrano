import { describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import { buildStructure, detectBoilerplate, detectLanguage, parseBlocks } from "@/lib/documents/segment";
import { detectFormat } from "@/lib/documents/formats";
import { checkCitationSupport, normalizeDocMarkers, validateDocCitations } from "@/lib/documents/citations";
import { analyzeQuestion, chapterPattern, compressPages } from "@/lib/documents/retrieval-intent";
import { csvUnits, parseCsv, splitParts } from "@/lib/documents/extract/text";
import { htmlToMarkdown } from "@/lib/documents/extract/html";
import { extractPptx, extractXlsx } from "@/lib/documents/extract/office";
import { readZip, ZipLimitError } from "@/lib/documents/extract/zip";
import { analysisWindows, consolidateMethods, sanitizeAnalysis } from "@/lib/documents/analyze";
import { quotedPhrases, rrf } from "@/lib/documents/search-utils";
import type { ExtractedUnit } from "@/lib/documents/types";

const page = (number: number, text: string, extra: Partial<ExtractedUnit> = {}): ExtractedUnit => ({ number, method: "TEXT", status: "OK", text, ...extra });

describe("structure et segmentation", () => {
  it("détecte les titres numérotés et nommés, conserve les pages et la hiérarchie", () => {
    const units = [
      page(1, "Chapitre 1 Introduction\nCe rapport décrit la méthode de calibration utilisée sur le site.\n\n1.1 Contexte\nLes mesures ont été faites en 2024."),
      page(2, "2 Méthodes\nLa procédure comporte trois étapes.\n- Mesurer la tension.\n- Comparer au seuil.\n- Consigner le résultat."),
    ];
    const blocks = parseBlocks(units, { plain: true });
    const { sections, segments } = buildStructure(blocks, "Rapport", { targetTokens: 400, overlapTokens: 40 });
    expect(sections.map((s) => s.title)).toEqual(["Chapitre 1 Introduction", "1.1 Contexte", "2 Méthodes"]);
    expect(sections[1].path).toEqual(["Chapitre 1 Introduction", "1.1 Contexte"]);
    expect(sections[2].pageStart).toBe(2);
    expect(segments.every((s) => s.page !== null && s.sectionPath.length > 0)).toBe(true);
    expect(segments.find((s) => s.content.includes("Comparer au seuil"))?.page).toBe(2);
  });

  it("ne coupe pas un tableau de son en-tête et garde la légende avec le tableau", () => {
    const rows = Array.from({ length: 120 }, (_, i) => `| Ligne ${i} | valeur ${i * 3} | commentaire assez long numéro ${i} |`);
    const text = ["# Résultats", "Tableau 3 : mesures relevées", "| Mesure | Valeur | Note |", "| --- | --- | --- |", ...rows].join("\n");
    const { segments } = buildStructure(parseBlocks([page(5, text)], { plain: false }), "Doc", { targetTokens: 300, overlapTokens: 30 });
    const tables = segments.filter((s) => s.type === "TABLE");
    expect(tables.length).toBeGreaterThan(2);
    for (const t of tables) {
      expect(t.content).toContain("| Mesure | Valeur | Note |");
      expect(t.content).toContain("Tableau 3 : mesures relevées");
    }
    const all = tables.map((t) => t.content).join("\n");
    for (const i of [0, 59, 119]) expect(all).toContain(`| Ligne ${i} |`);
  });

  it("recolle un paragraphe coupé par un saut de page et retire en-têtes/pieds répétés", () => {
    const units = Array.from({ length: 8 }, (_, i) => page(i + 1, `RAPPORT ANNUEL 2025\nTexte de la page ${i + 1} qui se termine sans point et continue\n${i + 1}`));
    units[3] = page(4, "RAPPORT ANNUEL 2025\nUne phrase interrompue par la fin de la page\n4");
    units[4] = page(5, "RAPPORT ANNUEL 2025\net qui se poursuit ici sur la suivante.\n5");
    const boiler = detectBoilerplate(units);
    const blocks = parseBlocks(units, { plain: true, boilerplate: boiler });
    expect(blocks.some((b) => b.type !== "heading" && "text" in b && b.text.includes("RAPPORT ANNUEL"))).toBe(false);
    expect(blocks.some((b) => b.type === "paragraph" && b.text.includes("fin de la page et qui se poursuit"))).toBe(true);
  });

  it("ne sépare pas une conclusion courte de son explication quand la marge le permet", () => {
    const filler = "Les essais successifs montrent une dérive lente des capteurs exposés à la chaleur. ".repeat(18);
    const text = `# Analyse\n${filler}\n\nAinsi, la recalibration trimestrielle est nécessaire.`;
    const { segments } = buildStructure(parseBlocks([page(1, text)], { plain: false }), "Doc", { targetTokens: 300, overlapTokens: 0 });
    const withConclusion = segments.find((s) => s.content.includes("Ainsi, la recalibration"));
    expect(withConclusion?.content).toContain("dérive lente");
  });

  it("horodate chaque phrase transcrite", () => {
    const unit = page(1, "## 00:00:00 – 00:05:00\n\n[00:01:05] On ouvre le panneau de configuration.\n\n[00:02:10] Puis on règle le seuil à 40.", { method: "TRANSCRIPT", startMs: 0, endMs: 300_000 });
    const { segments } = buildStructure(parseBlocks([unit], { plain: false }), "Vidéo", { targetTokens: 300, overlapTokens: 0 });
    expect(segments[0].type).toBe("TRANSCRIPT");
    expect(segments[0].startMs).toBe(65_000);
  });

  it("détecte la langue", () => {
    expect(detectLanguage("Le rapport est publié dans la revue et les auteurs présentent une méthode pour les mesures.")).toBe("french");
    expect(detectLanguage("The report is published in the journal and the authors present a method for the measurements of this system.")).toBe("english");
  });
});

describe("formats", () => {
  it("exige la concordance extension / signature", () => {
    expect(detectFormat("a.pdf", Buffer.from("%PDF-1.7 ..."))).toMatchObject({ kind: "PDF" });
    expect("error" in detectFormat("a.pdf", Buffer.from("MZ\x90\x00 exécutable"))).toBe(true);
    expect("error" in detectFormat("a.docx", Buffer.from("%PDF-1.4"))).toBe(true);
    expect("error" in detectFormat("a.exe", Buffer.from("MZ"))).toBe(true);
    expect("error" in detectFormat("notes.txt", Buffer.from([0x41, 0x00, 0x42]))).toBe(true);
    expect(detectFormat("photo.PNG", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d]))).toMatchObject({ kind: "IMAGE" });
  });
});

describe("références documentaires", () => {
  it("normalise les variantes et supprime les références inventées", () => {
    expect(normalizeDocMarkers("Voir [D 1, D3] et (D2) puis [Doc 4].")).toBe("Voir [D1][D3] et [D2] puis [D4].");
    const r = validateDocCitations("Le seuil est de 40 V [D1][D9]. Rien [D1][D1].", new Set([1, 2]));
    expect(r.content).toBe("Le seuil est de 40 V [D1]. Rien [D1].");
    expect(r.cited).toEqual([1]);
    expect(r.removed).toBe(1);
  });

  it("vérifie qu'un passage soutient la phrase qui le cite (chiffres compris)", () => {
    const passages = new Map([
      [1, "La procédure de calibration impose un seuil de tension de 40 volts mesuré à vide."],
      [2, "Le chapitre traite de l'historique de l'entreprise et de ses fondateurs."],
    ]);
    const checks = checkCitationSupport("La calibration impose un seuil de tension de 40 volts [D1]. La calibration impose un seuil de tension de 55 volts [D2].", passages);
    expect(checks.find((c) => c.n === 1)?.supported).toBe(true);
    expect(checks.find((c) => c.n === 2)?.supported).toBe(false);
  });
});

describe("analyse de la question", () => {
  it("reconnaît intentions, pages et chapitres", () => {
    expect(analyzeQuestion("Retrouve toutes les méthodes utilisées pour résoudre ce problème.").intent).toBe("methods");
    expect(analyzeQuestion("Dans quelles pages cette procédure est-elle expliquée ?").intent).toBe("locate");
    const cmp = analyzeQuestion("Compare les approches présentées dans les chapitres 2 et 8.");
    expect(cmp.intent).toBe("compare");
    expect(cmp.chapters).toEqual(["chapitre 2", "chapitre 8"]);
    expect(analyzeQuestion("Existe-t-il des contradictions entre les différentes sections ?").intent).toBe("contradictions");
    expect(analyzeQuestion("Fais une synthèse complète de ce document.").intent).toBe("summary");
    const occ = analyzeQuestion("Recherche toutes les occurrences de la notion « dérive thermique » et explique les différences de contexte.");
    expect(occ.intent).toBe("occurrences");
    expect(occ.term).toBe("dérive thermique");
    expect(analyzeQuestion("Que dit le document entre les pages 120 à 140 ?")).toMatchObject({ pageFrom: 120, pageTo: 140 });
  });

  it("produit un motif de chapitre qui ne confond pas 2 et 12", () => {
    const re = new RegExp(chapterPattern("chapitre 2"), "i");
    expect(re.test("Chapitre 2 Méthodes › 2.1 Mesures")).toBe(true);
    expect(re.test("2 Méthodes")).toBe(true);
    expect(re.test("Chapitre 12 Annexes")).toBe(false);
    expect(re.test("12 Annexes")).toBe(false);
    expect(compressPages([1, 2, 3, 7, 9, 10])).toBe("1–3, 7, 9–10");
  });
});

describe("extracteurs", () => {
  it("lit un CSV avec guillemets et répète l'en-tête dans chaque bloc", () => {
    expect(parseCsv('a;b\n"x;1";"dit ""oui"""\n').rows).toEqual([["a", "b"], ["x;1", 'dit "oui"']]);
    const csv = ["nom,valeur", ...Array.from({ length: 900 }, (_, i) => `n${i},${i}`)].join("\n");
    const { units } = csvUnits(csv, 400);
    expect(units).toHaveLength(3);
    for (const u of units) expect(u.text.startsWith("| nom | valeur |")).toBe(true);
    expect(units[2].label).toBe("Lignes 802–901");
  });

  it("convertit le HTML (titres, listes, tableaux) sans scripts", () => {
    const md = htmlToMarkdown("<h2>Étapes</h2><ol><li>Ouvrir</li><li>Régler</li></ol><table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table><script>alert(1)</script>");
    expect(md).toContain("## Étapes");
    expect(md).toContain("1. Ouvrir");
    expect(md).toContain("| A | B |");
    expect(md).not.toContain("alert");
  });

  it("découpe un texte long en parties sur les frontières de paragraphes", () => {
    const text = Array.from({ length: 80 }, (_, i) => `Paragraphe ${i} ${"mot ".repeat(60)}`).join("\n\n");
    const parts = splitParts(text);
    expect(parts.length).toBeGreaterThan(2);
    expect(parts.every((p) => /^Paragraphe \d+/.test(p.text))).toBe(true);
  });

  it("lit les diapositives (titre, puces, tableau, notes) et les feuilles de calcul", () => {
    const slide = `<p:sld><p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><a:p><a:r><a:t>Plan d'action</a:t></a:r></a:p></p:sp><p:sp><a:p><a:r><a:t>Former les équipes</a:t></a:r></a:p><a:p><a:r><a:t>Mesurer &amp; suivre</a:t></a:r></a:p></p:sp><a:tbl><a:tr><a:tc><a:p><a:r><a:t>Risque</a:t></a:r></a:p></a:tc><a:tc><a:p><a:r><a:t>Niveau</a:t></a:r></a:p></a:tc></a:tr><a:tr><a:tc><a:p><a:r><a:t>Panne</a:t></a:r></a:p></a:tc><a:tc><a:p><a:r><a:t>Élevé</a:t></a:r></a:p></a:tc></a:tr></a:tbl></p:sld>`;
    const pptx = zipSync({
      "ppt/slides/slide1.xml": strToU8(slide),
      "ppt/slides/_rels/slide1.xml.rels": strToU8('<Relationships><Relationship Target="../notesSlides/notesSlide1.xml"/></Relationships>'),
      "ppt/notesSlides/notesSlide1.xml": strToU8("<p:notes><a:p><a:r><a:t>Insister sur la sécurité</a:t></a:r></a:p></p:notes>"),
    });
    const r = extractPptx(pptx);
    expect(r.units[0].text).toContain("# Plan d'action");
    expect(r.units[0].text).toContain("- Mesurer & suivre");
    expect(r.units[0].text).toContain("| Panne | Élevé |");
    expect(r.units[0].text).toContain("> Notes : Insister sur la sécurité");

    const xlsx = zipSync({
      "xl/workbook.xml": strToU8('<workbook><sheets><sheet name="Ventes" sheetId="1" r:id="rId1"/></sheets></workbook>'),
      "xl/_rels/workbook.xml.rels": strToU8('<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'),
      "xl/sharedStrings.xml": strToU8("<sst><si><t>Produit</t></si><si><t>Total</t></si><si><t>Vis</t></si></sst>"),
      "xl/worksheets/sheet1.xml": strToU8('<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="s"><v>2</v></c><c r="C2"><v>42</v></c></row></sheetData></worksheet>'),
    });
    const x = extractXlsx(xlsx);
    expect(x.units[0].label).toBe("Feuille Ventes");
    expect(x.units[0].text).toContain("| Produit | Total |  |");
    expect(x.units[0].text).toContain("| Vis |  | 42 |");
  });

  it("refuse une archive dont la taille décompressée est excessive", () => {
    const bomb = zipSync({ "ppt/slides/slide1.xml": new Uint8Array(30 * 1024 * 1024) }, { level: 9 });
    expect(() => readZip(bomb, () => true, { maxEntries: 10, maxEntryBytes: 10 * 1024 * 1024, maxTotalBytes: 20 * 1024 * 1024, maxRatio: 100 })).toThrow(ZipLimitError);
  });
});

describe("analyse progressive", () => {
  it("découpe une section en fenêtres et retire les pages inventées", () => {
    const text = Array.from({ length: 30 }, (_, i) => `[p. ${i + 10}] ${"Texte de la page. ".repeat(30)}`).join("\n");
    const windows = analysisWindows(text, 800);
    expect(windows.length).toBeGreaterThan(3);
    expect(windows.join("\n").split("\n")).toHaveLength(30);
    const a = sanitizeAnalysis(
      { subject: "Calibration", summary: "x", concepts: [], definitions: [{ term: "Seuil", definition: "Valeur limite", page: 999 }], arguments: [], conclusions: [{ text: "OK", page: 10 }], methods: [{ name: "Recette inventée", objective: "o", explicit: true, steps: ["Danser la samba"], page: 10 }], causes: [], examples: [], rules: [], references: [], uncertain: [] },
      "[p. 10] La calibration se fait au seuil.\n[p. 11] Fin.",
    );
    expect(a.definitions[0].page).toBeNull();
    expect(a.conclusions[0].page).toBe(10);
    // « Explicite » mais introuvable dans le texte : rétrogradée en méthode déduite.
    expect(a.methods[0].explicit).toBe(false);
  });

  it("consolide une méthode décrite dans plusieurs sections", () => {
    const base = { objective: "", context: "", prerequisites: [], tools: [], decisionRules: [], inputs: [], outputs: [], pitfalls: [], limits: [], examples: [] };
    const merged = consolidateMethods([
      { ...base, name: "Méthode de calibration", explicit: true, steps: ["Mesurer"], page: 12, section: "2 Méthodes" },
      { ...base, name: "méthode de calibration", explicit: false, steps: ["Mesurer", "Comparer", "Consigner"], tools: ["Voltmètre"], page: 80, section: "8 Annexes" },
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].steps).toHaveLength(3);
    expect(merged[0].explicit).toBe(true);
    expect(merged[0].sources.map((s) => s.page)).toEqual([12, 80]);
  });
});

describe("fusion des classements", () => {
  it("RRF favorise les passages présents dans plusieurs listes", () => {
    const fused = rrf([
      { name: "lexical", weight: 1, ids: ["a", "b", "c"] },
      { name: "semantic", weight: 1, ids: ["c", "d", "a"] },
    ]);
    expect(fused[0].id).toBe("a");
    expect(fused[0].ranks).toEqual({ lexical: 1, semantic: 3 });
    expect(quotedPhrases('Où est « dérive thermique » et "seuil" ?')).toEqual(["dérive thermique", "seuil"]);
  });
});
