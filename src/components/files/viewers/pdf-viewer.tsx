"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ChevronLeft, ChevronRight, ZoomIn, ZoomOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ReadOnlyNote, ViewerToolbar, type ViewerProps } from "./common";

const ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];
const noSubscribe = () => () => {};

/**
 * Visionneuse PDF intégrée : pages rendues par le serveur (poppler), chargées à l'approche de la zone visible.
 * Fonctionne partout, y compris sur les navigateurs mobiles qui n'affichent pas les PDF dans une page.
 */
export function PdfViewer({ file }: ViewerProps) {
  const pages = Math.max(1, file.pageCount ?? 1);
  const [zoom, setZoom] = useState(1);
  const [current, setCurrent] = useState(1);
  const [input, setInput] = useState("1");
  const scroller = useRef<HTMLDivElement>(null);
  const refs = useRef<Array<HTMLDivElement | null>>([]);
  // Résolution du rendu adaptée au zoom et à la densité de l'écran.
  const dpr = useSyncExternalStore(noSubscribe, () => window.devicePixelRatio || 1, () => 1);
  const scale = zoom * dpr > 1.6 ? 3 : zoom * dpr > 0.9 ? 2 : 1;

  // Page courante = page la plus visible.
  useEffect(() => {
    const root = scroller.current;
    if (!root) return;
    const io = new IntersectionObserver(
      (entries) => {
        const best = entries.filter((e) => e.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
        if (best) {
          const n = Number((best.target as HTMLElement).dataset.page);
          setCurrent(n);
          setInput(String(n));
        }
      },
      { root, threshold: [0.25, 0.5, 0.75] },
    );
    refs.current.forEach((el) => el && io.observe(el));
    return () => io.disconnect();
  }, [pages]);

  const goTo = (n: number) => {
    const page = Math.min(Math.max(1, n), pages);
    refs.current[page - 1]?.scrollIntoView({ block: "start" });
    setInput(String(page));
  };
  const step = (dir: 1 | -1) => {
    const next = dir > 0 ? ZOOMS.find((z) => z > zoom + 0.001) : [...ZOOMS].reverse().find((z) => z < zoom - 0.001);
    if (next) setZoom(next);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ViewerToolbar>
        <Button type="button" variant="ghost" size="icon-sm" onClick={() => goTo(current - 1)} disabled={current <= 1} aria-label="Page précédente">
          <ChevronLeft />
        </Button>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            goTo(Number(input) || 1);
          }}
          className="flex items-center gap-1 text-xs"
        >
          <input value={input} onChange={(e) => setInput(e.target.value.replace(/\D/g, ""))} inputMode="numeric" aria-label="Aller à la page" className="h-7 w-10 rounded-md bg-muted text-center tabular-nums outline-none focus:ring-1 focus:ring-ring" />
          <span className="text-muted-foreground tabular-nums">/ {pages}</span>
        </form>
        <Button type="button" variant="ghost" size="icon-sm" onClick={() => goTo(current + 1)} disabled={current >= pages} aria-label="Page suivante">
          <ChevronRight />
        </Button>
        <span className="mx-1 h-4 w-px bg-border" aria-hidden />
        <Button type="button" variant="ghost" size="icon-sm" onClick={() => step(-1)} disabled={zoom <= ZOOMS[0]} aria-label="Zoom arrière">
          <ZoomOut />
        </Button>
        <span className="w-12 text-center text-xs tabular-nums">{Math.round(zoom * 100)} %</span>
        <Button type="button" variant="ghost" size="icon-sm" onClick={() => step(1)} disabled={zoom >= ZOOMS.at(-1)!} aria-label="Zoom avant">
          <ZoomIn />
        </Button>
        <div className="flex-1" />
        <ReadOnlyNote>Lecture seule</ReadOnlyNote>
      </ViewerToolbar>
      <div ref={scroller} className="min-h-0 flex-1 overflow-auto bg-muted/60 p-4">
        {/* 100 % = largeur du panneau, plafonnée à 900 px ; au-delà, défilement horizontal. */}
        <div className="mx-auto flex flex-col items-center gap-4" style={{ width: `min(${zoom * 100}%, ${zoom * 900}px)` }}>
          {Array.from({ length: pages }, (_, i) => (
            <div key={i} ref={(el) => void (refs.current[i] = el)} data-page={i + 1} className="w-full scroll-mt-4">
              {/* eslint-disable-next-line @next/next/no-img-element -- page rendue par l'API (session) */}
              <img
                src={`/api/chat/files/${file.id}/pages/${i + 1}?scale=${scale}&v=${file.version}`}
                alt={`Page ${i + 1} sur ${pages}`}
                loading={i < 2 ? "eager" : "lazy"}
                decoding="async"
                draggable={false}
                className="block aspect-[1/1.414] w-full rounded-sm bg-white object-contain shadow-sm [&[data-loaded]]:aspect-auto"
                onLoad={(e) => e.currentTarget.setAttribute("data-loaded", "")}
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
