// Générateur de PDF minimal (sans dépendance) pour des jeux de test reproductibles :
// pages de texte (Helvetica, encodage WinAnsi pour les accents) et pages « numérisées » (une image JPEG seule).

export type PdfPage =
  | { kind: "text"; lines: Array<string | { text: string; size?: number; bold?: boolean }> }
  | { kind: "image"; jpeg: Buffer; width: number; height: number; components?: 1 | 3 };

function latin1(text: string) {
  // Caractères hors Latin-1 remplacés : le jeu de test n'en contient pas, mais on reste robuste.
  return Buffer.from(text.replace(/[^\x00-\xff]/g, "?"), "latin1");
}

function escapeString(buf: Buffer) {
  const out: number[] = [];
  for (const b of buf) {
    if (b === 0x28 || b === 0x29 || b === 0x5c) out.push(0x5c);
    out.push(b);
  }
  return Buffer.from(out);
}

export function buildPdf(pages: PdfPage[], info: { title?: string; author?: string } = {}): Buffer {
  const objects: Buffer[] = [];
  const add = (body: Buffer | string) => {
    objects.push(typeof body === "string" ? Buffer.from(body, "latin1") : body);
    return objects.length;
  };
  const catalog = add("");
  const pagesObj = add("");
  const font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  const fontBold = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
  const kids: number[] = [];
  for (const page of pages) {
    let content: Buffer;
    let resources: string;
    if (page.kind === "text") {
      const parts: Buffer[] = [Buffer.from("BT\n")];
      let y = 800;
      for (const raw of page.lines) {
        const line = typeof raw === "string" ? { text: raw } : raw;
        const size = line.size ?? 10;
        y -= size + 4;
        parts.push(Buffer.from(`/${line.bold ? "F2" : "F1"} ${size} Tf 1 0 0 1 50 ${y} Tm (`, "latin1"), escapeString(latin1(line.text)), Buffer.from(") Tj\n"));
      }
      parts.push(Buffer.from("ET\n"));
      content = Buffer.concat(parts);
      resources = `<< /Font << /F1 ${font} 0 R /F2 ${fontBold} 0 R >> >>`;
    } else {
      const img = add(Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${page.width} /Height ${page.height} /ColorSpace /${page.components === 3 ? "DeviceRGB" : "DeviceGray"} /BitsPerComponent 8 /Filter /DCTDecode /Length ${page.jpeg.length} >>\nstream\n`), page.jpeg, Buffer.from("\nendstream")]));
      content = Buffer.from(`q 595 0 0 842 0 0 cm /Im1 Do Q\n`);
      resources = `<< /XObject << /Im1 ${img} 0 R >> >>`;
    }
    const stream = add(Buffer.concat([Buffer.from(`<< /Length ${content.length} >>\nstream\n`), content, Buffer.from("endstream")]));
    kids.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 595 842] /Resources ${resources} /Contents ${stream} 0 R >>`));
  }
  objects[catalog - 1] = Buffer.from(`<< /Type /Catalog /Pages ${pagesObj} 0 R >>`);
  objects[pagesObj - 1] = Buffer.from(`<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`);
  const infoObj = add(Buffer.concat([Buffer.from("<< /Title ("), escapeString(latin1(info.title ?? "")), Buffer.from(") /Author ("), escapeString(latin1(info.author ?? "")), Buffer.from(") >>")]));

  const chunks: Buffer[] = [Buffer.from("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n", "latin1")];
  let offset = chunks[0].length;
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(offset);
    const obj = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), body, Buffer.from("\nendobj\n")]);
    chunks.push(obj);
    offset += obj.length;
  });
  const xref = [`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`, ...offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`)].join("");
  chunks.push(Buffer.from(`${xref}trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R /Info ${infoObj} 0 R >>\nstartxref\n${offset}\n%%EOF\n`));
  return Buffer.concat(chunks);
}
