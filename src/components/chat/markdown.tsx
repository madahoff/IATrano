"use client";

import { memo, type ReactNode, isValidElement } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { CopyButton } from "@/components/common/copy-button";
import { cn } from "@/lib/utils";

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

// Le HTML brut n'est pas interprété (comportement par défaut de react-markdown) : pas d'injection possible.
export const Markdown = memo(function Markdown({ content, className }: { content: string; className?: string }) {
  return (
    <div className={cn("prose-chat", className)}>
      <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={components}>
        {content}
      </ReactMarkdown>
    </div>
  );
});
