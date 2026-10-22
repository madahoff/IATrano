// Artifacts : extraction pendant le streaming, validation, et document isolé de l'aperçu.
import { describe, expect, it } from "vitest";
import { cleanVisibleText, createArtifactExtractor, extractArtifacts, parseTitle, validateArtifact, type ExtractEvent } from "@/lib/artifacts/extract";
import { ARTIFACT_CSP, ARTIFACT_SANDBOX, buildDownloadDocument, buildSandboxDocument, isBridgeMessage, BRIDGE_TAG } from "@/lib/artifacts/sandbox";
import { buildCurrentArtifactBlock, buildRepairPrompt } from "@/lib/artifacts/prompt";

const PAGE = `<!doctype html>\n<html lang="fr"><head><title>Démo</title></head><body><h1>Bonjour</h1><script>document.body.dataset.ok = "1";</script></body></html>`;
const ANSWER = `Voici l'explication.\n\n<artifact title="Simulateur d&apos;intérêts">\n${PAGE}\n</artifact>\n\nBonne exploration !`;

/** Rejoue un texte découpé en morceaux de taille `size` dans l'extracteur. */
function stream(text: string, size: number) {
  const ex = createArtifactExtractor();
  const events: ExtractEvent[] = [];
  for (let i = 0; i < text.length; i += size) events.push(...ex.push(text.slice(i, i + size)));
  events.push(...ex.finish());
  return {
    events,
    visible: events.filter((e) => e.type === "text").map((e) => (e as { text: string }).text).join(""),
    code: events.filter((e) => e.type === "code").map((e) => (e as { delta: string }).delta).join(""),
    ends: events.filter((e) => e.type === "end" || e.type === "incomplete"),
  };
}

describe("extraction en flux", () => {
  it.each([1, 2, 3, 7, 64, 10_000])("découpage en morceaux de %i caractère(s) : même résultat", (size) => {
    const r = stream(ANSWER, size);
    expect(r.visible).toBe("Voici l'explication.\n\n\n\nBonne exploration !");
    expect(r.visible).not.toContain("<");
    expect(r.ends).toEqual([{ type: "end", title: "Simulateur d'intérêts", code: PAGE }]);
    expect(r.code.trim()).toBe(PAGE);
    expect(r.events.filter((e) => e.type === "start")).toEqual([{ type: "start", title: "Simulateur d'intérêts" }]);
  });

  it("le texte n'est jamais retardé au-delà du début possible d'une balise", () => {
    const ex = createArtifactExtractor();
    expect(ex.push("Bonjour <art")).toEqual([{ type: "text", text: "Bonjour " }]);
    expect(ex.push("iste>")).toEqual([{ type: "text", text: "<artiste>" }]);
  });

  it("ignore les balises voisines (<artifacts>, <article>)", () => {
    expect(extractArtifacts("Voir <artifacts> et <article>x</article>").text).toBe("Voir <artifacts> et <article>x</article>");
  });

  it("retire les clôtures Markdown autour du code et autour du bloc", () => {
    const r = extractArtifacts("Texte\n```html\n<artifact title='Frise'>\n```html\n<div>ok</div>\n```\n</artifact>\n```\nFin");
    expect(r.artifacts).toEqual([{ title: "Frise", code: "<div>ok</div>", complete: true }]);
    expect(r.text).toBe("Texte\n\nFin");
  });

  it("flux interrompu au milieu du code : page incomplète", () => {
    const r = stream('Début <artifact title="Calculateur"><html><body><button', 5);
    expect(r.visible).toBe("Début ");
    expect(r.ends).toEqual([{ type: "incomplete", title: "Calculateur", code: "<html><body><button" }]);
  });

  it("plusieurs pages, balises en majuscules, titre absent", () => {
    const r = extractArtifacts("A <ARTIFACT><div>1</div></ARTIFACT> B <artifact title=Schéma><svg></svg></artifact> C");
    expect(r.artifacts.map((a) => a.title)).toEqual(["Page interactive", "Schéma"]);
    expect(r.text).toBe("A  B  C");
  });

  it("titres : guillemets, entités, longueur", () => {
    expect(parseTitle(' title="Taux &quot;fixe&quot; &amp; variable"')).toBe('Taux "fixe" & variable');
    expect(parseTitle(" title='Frise'")).toBe("Frise");
    expect(parseTitle(` title="${"x".repeat(300)}"`)).toHaveLength(120);
  });

  it("nettoyage du texte visible", () => {
    expect(cleanVisibleText("a\n```html\n```\n\n\n\nb")).toBe("a\n\nb");
  });
});

describe("validation", () => {
  it("page correcte", () => {
    expect(validateArtifact(PAGE)).toEqual({ valid: true, issues: [] });
  });

  it("page incomplète, vide, sans HTML ou trop volumineuse : inutilisable", () => {
    expect(validateArtifact(PAGE, false).valid).toBe(false);
    expect(validateArtifact("   ").valid).toBe(false);
    expect(validateArtifact("Voici du texte sans balise.")).toMatchObject({ valid: false, issues: ["Le code ne contient pas de HTML exploitable."] });
    expect(validateArtifact(`<div>${"x".repeat(300_001)}</div>`).valid).toBe(false);
  });

  it("ressources externes, réseau et stockage : signalés (bloqués par le bac à sable) sans invalider", () => {
    const r = validateArtifact('<script src="https://cdn.example.com/chart.js"></script><script>fetch("/api"); localStorage.setItem("a","b")</script>');
    expect(r.valid).toBe(true);
    expect(r.issues).toHaveLength(3);
    expect(validateArtifact('<style>@import url("//fonts.example.com/x.css")</style>').issues[0]).toMatch(/Ressources externes/);
  });
});

describe("document isolé", () => {
  it("CSP stricte et pont injectés AVANT le code de la page", () => {
    const doc = buildSandboxDocument(PAGE);
    expect(doc.startsWith("<!doctype html><meta http-equiv=\"Content-Security-Policy\"")).toBe(true);
    expect(doc.indexOf("Content-Security-Policy")).toBeLessThan(doc.indexOf("<html"));
    expect(doc.indexOf(BRIDGE_TAG)).toBeLessThan(doc.indexOf("<html"));
    // Un seul doctype (sinon mode quirks).
    expect(doc.match(/<!doctype/gi)).toHaveLength(1);
  });

  it("aucune requête réseau, aucun cadre, aucun formulaire", () => {
    for (const d of ["default-src 'none'", "connect-src 'none'", "form-action 'none'", "frame-src 'none'", "worker-src 'none'", "base-uri 'none'", "img-src data: blob:"]) {
      expect(ARTIFACT_CSP).toContain(d);
    }
    expect(ARTIFACT_CSP).not.toMatch(/https?:|\*/);
  });

  it("iframe : scripts seulement, jamais la même origine", () => {
    expect(ARTIFACT_SANDBOX).toBe("allow-scripts");
  });

  it("une CSP déclarée par la page ne peut pas assouplir la nôtre", () => {
    const doc = buildSandboxDocument(`<head><meta http-equiv="Content-Security-Policy" content="default-src *"></head><body>x</body>`);
    expect(doc).not.toContain("default-src *");
  });

  it("fichier téléchargé : même CSP, titre neutralisé", () => {
    const file = buildDownloadDocument(PAGE, 'Démo <script>"');
    expect(file).toContain(ARTIFACT_CSP);
    expect(file).toContain("<!-- Démo script — généré par IATrano -->");
  });

  it("reconnaît uniquement les messages du pont", () => {
    expect(isBridgeMessage({ [BRIDGE_TAG]: true, type: "error", detail: {} })).toBe(true);
    expect(isBridgeMessage({ type: "error" })).toBe(false);
    expect(isBridgeMessage("x")).toBe(false);
  });
});

describe("consignes", () => {
  it("demande de modification : code actuel transmis, tronqué au-delà de 60 k caractères", () => {
    expect(buildCurrentArtifactBlock({ title: 'Le "titre"', version: 2, code: "<div></div>" })).toBe("<current_artifact title=\"Le 'titre'\" version=\"2\">\n<div></div>\n</current_artifact>");
    expect(buildCurrentArtifactBlock({ title: "t", version: 1, code: "x".repeat(70_000) })).toContain("code tronqué");
  });

  it("réparation : code et erreur renvoyés, réponse attendue = page complète", () => {
    const [sys, user] = buildRepairPrompt({ title: "Démo", code: PAGE }, "Erreur JavaScript : x is not defined");
    expect(sys.content).toMatch(/UNIQUEMENT par le bloc <artifact/);
    expect(user.content).toContain(PAGE);
    expect(user.content).toContain("x is not defined");
  });
});
