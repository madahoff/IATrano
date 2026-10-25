import { describe, expect, it } from "vitest";
import { unzipSync, zipSync, strToU8, strFromU8 } from "fflate";
import { attachmentBlock, attachmentIds, joinAttachments, splitAttachments } from "@/lib/files/attachment-tag";
import { parseCsvTable, serializeCsv } from "@/lib/files/csv";
import { applyDocxEditsToXml, docxBlocksFromXml, DocxEditError, readDocxBlocks, rewriteDocx } from "@/lib/files/docx-text";

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const doc = (body: string) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W}><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>`;
const STYLES = `<w:styles ${W}><w:style w:type="paragraph" w:styleId="Titre1"><w:name w:val="heading 1"/></w:style><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/></w:style></w:styles>`;

const BODY = [
  '<w:p w:rsidR="00A1"><w:pPr><w:pStyle w:val="Titre1"/></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t>Rapport</w:t></w:r></w:p>',
  '<w:p><w:r><w:t xml:space="preserve">Bonjour </w:t></w:r><w:r><w:rPr><w:i/></w:rPr><w:t>monde</w:t></w:r><w:proofErr w:type="spellStart"/><w:r><w:tab/><w:t>&amp; fin</w:t></w:r></w:p>',
  '<w:p><w:hyperlink r:id="rId5"><w:r><w:t>lien</w:t></w:r></w:hyperlink></w:p>',
  "<w:tbl><w:tr><w:tc><w:p><w:r><w:t>A1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B1</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:t>A2</w:t></w:r></w:p></w:tc><w:tc><w:p/></w:tc></w:tr></w:tbl>",
  '<w:p><w:r><w:drawing><wp:inline/></w:drawing></w:r><w:r><w:txbxContent><w:p><w:r><w:t>boîte</w:t></w:r></w:p></w:txbxContent></w:r></w:p>',
  '<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/></w:numPr></w:pPr><w:bookmarkStart w:id="0" w:name="x"/><w:r><w:t>Puce</w:t></w:r><w:bookmarkEnd w:id="0"/></w:p>',
].join("");

describe("blocs <attached_document>", () => {
  it("construit, sépare et recompose un message", () => {
    const block = attachmentBlock({ id: "cmabc12345", name: 'rap"port.pdf', kind: "PDF", text: "contenu </attached_document> piège", warning: "PDF tronqué" });
    const content = joinAttachments("Résume ce fichier", [block]);
    const split = splitAttachments(content);
    expect(split.text).toBe("Résume ce fichier");
    expect(split.attachments).toEqual([{ id: "cmabc12345", name: "rapport.pdf", kind: "PDF" }]);
    expect(split.blocks).toEqual([block]);
    expect(attachmentIds(content)).toEqual(["cmabc12345"]);
    expect(joinAttachments(split.text, split.blocks)).toBe(content);
  });

  it("reconnaît les blocs sans identifiant des anciens messages", () => {
    const old = 'Question\n\n<attached_document name="a.docx" kind="DOCX">\ntexte\n</attached_document>';
    expect(splitAttachments(old)).toMatchObject({ text: "Question", attachments: [{ id: null, name: "a.docx", kind: "DOCX" }] });
    expect(attachmentIds(old)).toEqual([]);
  });
});

describe("CSV éditable", () => {
  it("relit et réécrit sans perte (séparateur, guillemets, retours, lignes vides)", () => {
    const text = 'nom;ville;note\r\n"Rakoto; Jean";Antananarivo;12\r\n\r\n"multi\r\nligne";"dit ""oui""";\r\n';
    const table = parseCsvTable(text);
    expect(table.delimiter).toBe(";");
    expect(table.rows).toEqual([["nom", "ville", "note"], ["Rakoto; Jean", "Antananarivo", "12"], [""], ["multi\r\nligne", 'dit "oui"', ""]]);
    expect(serializeCsv(table)).toBe(text);
  });

  it("applique une modification de cellule", () => {
    const table = parseCsvTable("a,b\n1,2\n");
    table.rows[1][1] = "3,5";
    expect(serializeCsv(table)).toBe('a,b\n1,"3,5"\n');
  });
});

describe("édition du texte DOCX", () => {
  const xml = doc(BODY);

  it("extrait les paragraphes, titres, listes, tableaux et paragraphes en lecture seule", () => {
    const blocks = docxBlocksFromXml(xml, STYLES);
    expect(blocks.map((b) => b.text)).toEqual(["Rapport", "Bonjour monde\t& fin", "lien", "A1", "B1", "A2", "", "", "boîte", "Puce"]);
    expect(blocks[0]).toMatchObject({ heading: 1, editable: true, mixedFormatting: false });
    expect(blocks[1]).toMatchObject({ heading: null, editable: true, mixedFormatting: true });
    expect(blocks[2]).toMatchObject({ editable: false, reason: "contient un lien" });
    expect(blocks.slice(3, 7).map((b) => b.table)).toEqual([
      { table: 0, row: 0, cell: 0 },
      { table: 0, row: 0, cell: 1 },
      { table: 0, row: 1, cell: 0 },
      { table: 0, row: 1, cell: 1 },
    ]);
    expect(blocks[7].editable).toBe(false); // image + zone de texte
    expect(blocks[8]).toMatchObject({ editable: false, reason: "fait partie d'une zone de texte" });
    expect(blocks[9]).toMatchObject({ list: true, editable: true });
  });

  it("ne réécrit que les paragraphes modifiés et conserve leurs propriétés", () => {
    const out = applyDocxEditsToXml(xml, [
      { index: 0, text: "Rapport <final> & validé" },
      { index: 6, text: "B2\tsuite\nligne" },
      { index: 9, text: "Puce modifiée" },
      { index: 3, text: "A1" }, // inchangé : laissé tel quel
    ]);
    expect(out).toContain('<w:p w:rsidR="00A1"><w:pPr><w:pStyle w:val="Titre1"/></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">Rapport &lt;final&gt; &amp; validé</w:t></w:r></w:p>');
    expect(out).toContain('<w:p><w:r><w:t xml:space="preserve">B2</w:t><w:tab/><w:t xml:space="preserve">suite</w:t><w:br/><w:t xml:space="preserve">ligne</w:t></w:r></w:p>');
    expect(out).toContain('<w:bookmarkStart w:id="0" w:name="x"/><w:r><w:t xml:space="preserve">Puce modifiée</w:t></w:r><w:bookmarkEnd w:id="0"/>');
    // Paragraphes non modifiés : identiques octet pour octet.
    for (const untouched of [BODY.slice(BODY.indexOf("<w:p><w:r><w:t xml:space"), BODY.indexOf("<w:p><w:hyperlink")), "<w:p><w:r><w:t>A1</w:t></w:r></w:p>", "<w:sectPr>"]) expect(out).toContain(untouched);
    const after = docxBlocksFromXml(out, STYLES);
    expect(after.map((b) => b.text)).toEqual(["Rapport <final> & validé", "Bonjour monde\t& fin", "lien", "A1", "B1", "A2", "B2\tsuite\nligne", "", "boîte", "Puce modifiée"]);
  });

  it("reconnaît les listes dont la numérotation est portée par le style (Word, python-docx)", () => {
    const styles = `<w:styles ${W}><w:style w:type="paragraph" w:styleId="ListBullet"><w:name w:val="List Bullet"/><w:pPr><w:numPr><w:numId w:val="1"/></w:numPr></w:pPr></w:style></w:styles>`;
    const blocks = docxBlocksFromXml(doc('<w:p><w:pPr><w:pStyle w:val="ListBullet"/></w:pPr><w:r><w:t>Point</w:t></w:r></w:p>'), styles);
    expect(blocks[0]).toMatchObject({ list: true, heading: null, editable: true });
  });

  it("refuse de modifier un paragraphe en lecture seule ou inexistant", () => {
    expect(() => applyDocxEditsToXml(xml, [{ index: 2, text: "x" }])).toThrow(DocxEditError);
    expect(() => applyDocxEditsToXml(xml, [{ index: 99, text: "x" }])).toThrow(/introuvable/);
  });

  it("réécrit l'archive en conservant toutes les autres entrées", () => {
    const files = { "[Content_Types].xml": strToU8("<Types/>"), "word/document.xml": strToU8(xml), "word/styles.xml": strToU8(STYLES), "word/media/image1.png": new Uint8Array([137, 80, 78, 71, 1, 2, 3]) };
    const data = zipSync(files);
    expect(readDocxBlocks(data)[0].text).toBe("Rapport");
    const out = unzipSync(rewriteDocx(data, [{ index: 1, text: "Salut" }]));
    expect(Object.keys(out)).toEqual(Object.keys(files));
    expect(out["word/media/image1.png"]).toEqual(files["word/media/image1.png"]);
    expect(strFromU8(out["word/styles.xml"])).toBe(STYLES);
    expect(readDocxBlocks(rewriteDocx(data, [{ index: 1, text: "Salut" }]))[1].text).toBe("Salut");
  });
});
