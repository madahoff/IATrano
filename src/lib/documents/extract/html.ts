import { parse, type HTMLElement, type Node } from "node-html-parser";

// HTML → Markdown léger (texte canonique du pipeline) : titres « # », listes « - », tableaux Markdown
// avec leur ligne d'en-tête, légendes « Légende : ». Scripts, styles et formulaires sont ignorés.

const SKIP = new Set(["script", "style", "noscript", "template", "iframe", "object", "embed", "svg", "form", "button", "select", "input", "textarea", "head"]);
const BLOCK = new Set(["p", "div", "section", "article", "main", "header", "footer", "aside", "blockquote", "pre", "address", "dd", "dt", "figure", "nav"]);

const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();

function inline(node: Node): string {
  if (node.nodeType === 3) return node.text;
  const el = node as HTMLElement;
  const tag = el.tagName?.toLowerCase() ?? "";
  if (SKIP.has(tag)) return "";
  if (tag === "br") return "\n";
  if (tag === "img") {
    const alt = el.getAttribute("alt")?.trim();
    return alt ? ` [Image : ${alt}] ` : "";
  }
  return el.childNodes.map(inline).join("");
}

function table(el: HTMLElement): string[] {
  const rows = el.querySelectorAll("tr").map((tr) => tr.querySelectorAll("th,td").map((c) => cell(inline(c))));
  const width = Math.max(0, ...rows.map((r) => r.length));
  if (!rows.length || width === 0) return [];
  const pad = (r: string[]) => `| ${[...r, ...Array(width - r.length).fill("")].join(" | ")} |`;
  const out: string[] = [];
  const caption = el.querySelector("caption");
  if (caption) out.push(`Légende : ${cell(inline(caption))}`);
  out.push(pad(rows[0]));
  // Sans <th>, la première ligne est tout de même traitée comme en-tête (convention des tableurs et de Word).
  out.push(`|${" --- |".repeat(width)}`);
  for (const r of rows.slice(1)) out.push(pad(r));
  return out;
}

export function htmlToMarkdown(html: string): string {
  const root = parse(html, { blockTextElements: { script: false, style: false, noscript: false, pre: true } });
  const lines: string[] = [];
  const push = (text: string) => {
    const t = text.replace(/[ \t ]+/g, " ").replace(/ *\n */g, "\n").trim();
    if (t) lines.push(t, "");
  };
  const walk = (node: Node, listDepth = 0) => {
    if (node.nodeType === 3) {
      push(node.text);
      return;
    }
    const el = node as HTMLElement;
    const tag = el.tagName?.toLowerCase() ?? "";
    if (SKIP.has(tag)) return;
    const h = /^h([1-6])$/.exec(tag);
    if (h) return push(`${"#".repeat(Number(h[1]))} ${inline(el).replace(/\s+/g, " ").trim()}`);
    if (tag === "table") {
      const t = table(el);
      if (t.length) lines.push(...t, "");
      return;
    }
    if (tag === "ul" || tag === "ol") {
      let i = 0;
      for (const child of el.childNodes) {
        const c = child as HTMLElement;
        if (c.tagName?.toLowerCase() !== "li") continue;
        i++;
        const nested = c.childNodes.filter((n) => ["ul", "ol"].includes((n as HTMLElement).tagName?.toLowerCase() ?? ""));
        const own = c.childNodes.filter((n) => !nested.includes(n)).map(inline).join("").replace(/\s+/g, " ").trim();
        if (own) lines.push(`${"  ".repeat(listDepth)}${tag === "ol" ? `${i}.` : "-"} ${own}`);
        for (const n of nested) walk(n, listDepth + 1);
      }
      lines.push("");
      return;
    }
    if (tag === "figcaption" || (tag === "p" && /caption|legende|légende/i.test(el.getAttribute("class") ?? ""))) return push(`Légende : ${inline(el)}`);
    if (BLOCK.has(tag) || tag === "li") {
      const hasBlockChild = el.childNodes.some((n) => {
        const t = (n as HTMLElement).tagName?.toLowerCase() ?? "";
        return BLOCK.has(t) || t === "table" || t === "ul" || t === "ol" || /^h[1-6]$/.test(t);
      });
      if (!hasBlockChild) return push(inline(el));
    }
    for (const child of el.childNodes) walk(child, listDepth);
  };
  walk(root);
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
