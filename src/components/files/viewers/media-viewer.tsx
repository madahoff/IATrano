"use client";

import { useState, useSyncExternalStore } from "react";
import { contentUrl, ErrorNotice, ReadOnlyNote, ViewerToolbar, type ViewerProps } from "./common";

const noSubscribe = () => () => {};

/** Lecteur audio / vidéo du navigateur. Un format qu'il ne sait pas lire est signalé au lieu d'un lecteur muet. */
export function MediaViewer({ file }: ViewerProps) {
  const video = file.kind === "VIDEO";
  // Capacité du navigateur (null pendant le rendu serveur).
  const supported = useSyncExternalStore(
    noSubscribe,
    () => document.createElement(video ? "video" : "audio").canPlayType(file.mimeType) !== "",
    () => null,
  );
  const [failed, setFailed] = useState(false);

  if (supported === false || failed) {
    return <ErrorNotice message={`Ce navigateur ne sait pas lire ce format (${file.mimeType}). Téléchargez le fichier pour l’ouvrir avec un lecteur adapté.`} />;
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ViewerToolbar>
        <div className="flex-1" />
        <ReadOnlyNote>Lecture seule</ReadOnlyNote>
      </ViewerToolbar>
      <div className="flex min-h-0 flex-1 items-center justify-center bg-muted/50 p-4">
        {supported &&
          (video ? (
            <video src={contentUrl(file)} controls preload="metadata" onError={() => setFailed(true)} className="max-h-full max-w-full rounded-lg bg-black">
              <track kind="captions" />
            </video>
          ) : (
            <audio src={contentUrl(file)} controls preload="metadata" onError={() => setFailed(true)} className="w-full max-w-xl" />
          ))}
      </div>
    </div>
  );
}
