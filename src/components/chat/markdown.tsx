"use client";

import { memo, useMemo, type ReactNode, isValidElement } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { CopyButton } from "@/components/common/copy-button";
import { cn } from "@/lib/utils";
import { hideIncompleteMarker, tokenizeCitations } from "@/lib/chat/citations";
import { hideIncompleteDocMarker, tokenizeDocCitations } from "@/lib/documents/citations";
import type { DocumentRetrievalDTO } from "@/lib/documents/types";
import type { SourceDTO } from "@/lib/search/research-types";
import { CitationChip } from "./sources";
import { DocCitationChip } from "./documents/doc-sources";

function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
  return "";
}

const components: Components = {
  pre({ children }) {
    const child = Array.isArray(children) ? children[0] : children;
    const className = isValidElement<{ className?: string }>(child) ? (child.props.className ?? "") : "";
    const lang = /language-([\w+-]+)/.exec(className)?.[1];
    const code = textOf(children).replace(/\n$/, "");
    return (
      <div className="not-prose my-4 overflow-hidden rounded-2xl bg-code">
        <div className="flex items-center justify-between py-1 pr-1.5 pl-4 text-xs text-muted-foreground">
          <span className="font-mono">{lang ?? "texte"}</span>
          <CopyButton text={code} label="Copier le code" showLabel />
        </div>
        <pre className="overflow-x-auto px-4 pb-4 font-mono text-[0.83rem] leading-6">{children}</pre>
      </div>
    );
  },
  a({ href, children }) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer nofollow">
        {children}
      </a>
    );
  },
  table({ children }) {
    return (
      <div className="overflow-x-auto rounded-xl">
        <table>{children}</table>
      </div>
    );
  },
};

const remarkPlugins = [remarkGfm];
const rehypePlugins = [[rehypeHighlight, { detect: false, ignoreMissing: true }]] as never;

type MdNode = { type: string; value?: string; children?: MdNode[]; data?: Record<string, unknown> };

/**
 * Plugin remark : transforme les marqueurs [n] des nœuds texte (hors code et liens) en nœuds « citation »
 * structurés, uniquement pour les numéros présents dans la liste des sources de la réponse.
 */
function remarkCitations(known: ReadonlySet<number>) {
  return () => (tree: MdNode) => {
    const walk = (node: MdNode) => {
      if (!node.children || node.type === "link" || node.type === "linkReference" || node.type === "code" || node.type === "inlineCode") return;
      node.children = node.children.flatMap((child): MdNode[] => {
        if (child.type !== "text" || !child.value?.includes("[")) {
          walk(child);
          return [child];
        }
        return tokenizeCitations(child.value, known).map((t) =>
          t.type === "text"
            ? { type: "text", value: t.value }
            : { type: "citation", data: { hName: "sup", hProperties: { dataCite: String(t.n) } }, children: [{ type: "text", value: String(t.n) }] },
        );
      });
    };
    walk(tree);
  };
}

/** Plugin remark : marqueurs documentaires [Dn] connus → nœuds « citation » (hors code et liens). */
function remarkDocCitations(known: ReadonlySet<number>) {
  return () => (tree: MdNode) => {
    const walk = (node: MdNode) => {
      if (!node.children || node.type === "link" || node.type === "linkReference" || node.type === "code" || node.type === "inlineCode") return;
      node.children = node.children.flatMap((child): MdNode[] => {
        if (child.type !== "text" || !child.value?.includes("[D")) {
          walk(child);
          return [child];
        }
        return tokenizeDocCitations(child.value, known).map((t) =>
          t.type === "text" ? { type: "text", value: t.value } : { type: "citation", data: { hName: "sup", hProperties: { dataDcite: String(t.n) } }, children: [{ type: "text", value: `D${t.n}` }] },
        );
      });
    };
    walk(tree);
  };
}

// Le HTML brut n'est pas interprété (comportement par défaut de react-markdown) : pas d'injection possible.
export const Markdown = memo(function Markdown({
  content,
  className,
  sources,
  documents,
  streaming = false,
}: {
  content: string;
  className?: string;
  /** Sources de la réponse : active l'affichage des marqueurs [n] comme citations cliquables. */
  sources?: SourceDTO[];
  /** Passages des documents du projet : marqueurs [Dn] cliquables (avec vérification du soutien). */
  documents?: DocumentRetrievalDTO | null;
  streaming?: boolean;
}) {
  const citation = useMemo(() => {
    if (!sources && !documents?.sources.length) return null;
    const byN = new Map((sources ?? []).map((s) => [s.n, s]));
    const docByN = new Map((documents?.sources ?? []).map((s) => [s.n, s]));
    const checks = new Map((documents?.checks ?? []).map((c) => [c.n, c]));
    const comps: Components = {
      ...components,
      sup({ children, ...props }) {
        const p = props as Record<string, unknown>;
        if (p["data-dcite"] !== undefined) {
          const n = Number(p["data-dcite"]);
          const doc = docByN.get(n);
          return doc ? <DocCitationChip source={doc} check={checks.get(n)} /> : <sup>{children}</sup>;
        }
        const n = Number(p["data-cite"]);
        const source = byN.get(n);
        if (!source) return <sup>{children}</sup>;
        return <CitationChip n={n} source={source} />;
      },
    };
    const plugins = [remarkGfm, ...(sources ? [remarkCitations(new Set(byN.keys()))] : []), ...(docByN.size ? [remarkDocCitations(new Set(docByN.keys()))] : [])];
    return { plugins, components: comps };
  }, [sources, documents]);
  // Pendant le streaming, un marqueur encore incomplet (« [1 », « [D ») n'est pas affiché.
  let text = sources && streaming ? hideIncompleteMarker(content) : content;
  if (documents && streaming) text = hideIncompleteDocMarker(text);
  return (
    <div className={cn("prose-chat", className)}>
      <ReactMarkdown remarkPlugins={citation?.plugins ?? remarkPlugins} rehypePlugins={rehypePlugins} components={citation?.components ?? components}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
