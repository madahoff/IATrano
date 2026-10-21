// Découpe un flux de texte autour d'une balise <tag>…</tag> sans jamais émettre
// un fragment de balise partiel : la fin du tampon qui pourrait être le début d'une balise est retenue.

export type SplitPart = { inside: boolean; text: string };

function partialSuffix(buf: string, token: string): number {
  const max = Math.min(buf.length, token.length - 1);
  for (let len = max; len > 0; len--) {
    if (token.startsWith(buf.slice(buf.length - len))) return len;
  }
  return 0;
}

export class TagSplitter {
  private buf = "";
  private inside = false;
  private readonly open: string;
  private readonly close: string;
  /** Nombre de fois où la balise a été ouverte. */
  opened = 0;
  closed = 0;

  constructor(tag: string) {
    this.open = `<${tag}>`;
    this.close = `</${tag}>`;
  }

  get isInside() {
    return this.inside;
  }

  push(chunk: string): SplitPart[] {
    this.buf += chunk;
    const out: SplitPart[] = [];
    for (;;) {
      const token = this.inside ? this.close : this.open;
      const idx = this.buf.indexOf(token);
      if (idx >= 0) {
        if (idx > 0) out.push({ inside: this.inside, text: this.buf.slice(0, idx) });
        this.buf = this.buf.slice(idx + token.length);
        this.inside = !this.inside;
        if (this.inside) this.opened++;
        else this.closed++;
        continue;
      }
      const keep = partialSuffix(this.buf, token);
      const emit = this.buf.slice(0, this.buf.length - keep);
      if (emit) out.push({ inside: this.inside, text: emit });
      this.buf = this.buf.slice(this.buf.length - keep);
      return out;
    }
  }

  flush(): SplitPart[] {
    const rest = this.buf;
    this.buf = "";
    return rest ? [{ inside: this.inside, text: rest }] : [];
  }
}
