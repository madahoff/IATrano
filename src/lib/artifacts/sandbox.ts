// Document servi à l'iframe d'aperçu. Trois protections cumulées :
//  1. iframe sandbox="allow-scripts" SANS allow-same-origin : origine opaque, donc ni cookies, ni stockage,
//     ni accès à l'application parente ; pas de formulaires, popups, téléchargements ni navigation du parent ;
//  2. Content-Security-Policy injectée en tête : aucune requête réseau (connect, images, polices, scripts externes…) ;
//  3. un petit script « pont » qui remonte les erreurs JavaScript au parent (postMessage) pour les afficher.

export const ARTIFACT_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "media-src data: blob:",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-src 'none'",
  "child-src 'none'",
  "worker-src 'none'",
  "manifest-src 'none'",
].join("; ");

/** Attribut sandbox de l'iframe : scripts uniquement. */
export const ARTIFACT_SANDBOX = "allow-scripts";

/** Marqueur des messages envoyés par le pont (le parent vérifie aussi la fenêtre émettrice). */
export const BRIDGE_TAG = "__iatranoArtifact";

export type BridgeMessage = { [BRIDGE_TAG]: true; type: "error" | "ready" | "blocked"; detail: { message?: string; line?: number | null; uri?: string; directive?: string } };

const BRIDGE = `(function(){
var send=function(t,d){try{parent.postMessage({${BRIDGE_TAG}:true,type:t,detail:d},"*")}catch(e){}};
var mem=function(){var s={};return{getItem:function(k){return Object.prototype.hasOwnProperty.call(s,k)?s[k]:null},setItem:function(k,v){s[k]=String(v)},removeItem:function(k){delete s[k]},clear:function(){s={}},key:function(i){return Object.keys(s)[i]||null},get length(){return Object.keys(s).length}}};
["localStorage","sessionStorage"].forEach(function(n){try{window[n]}catch(e){try{Object.defineProperty(window,n,{value:mem(),configurable:true})}catch(_){}}});
window.addEventListener("error",function(e){send("error",{message:String(e.message||"Erreur JavaScript"),line:e.lineno||null})});
window.addEventListener("unhandledrejection",function(e){var r=e.reason;send("error",{message:"Promesse rejetée : "+String(r&&r.message||r)})});
document.addEventListener("securitypolicyviolation",function(e){send("blocked",{uri:String(e.blockedURI||""),directive:String(e.violatedDirective||"")})});
window.addEventListener("load",function(){send("ready",{})});
})();`;

/**
 * Construit le document de l'aperçu. La CSP et le pont sont placés AVANT tout le code de l'artifact :
 * le doctype d'origine est retiré (sinon mode quirks), ainsi que toute CSP déclarée par la page elle-même.
 */
export function buildSandboxDocument(code: string): string {
  const body = code
    .replace(/^\s*<!doctype[^>]*>/i, "")
    .replace(/<meta[^>]+http-equiv\s*=\s*["']?content-security-policy["']?[^>]*>/gi, "");
  return `<!doctype html><meta http-equiv="Content-Security-Policy" content="${ARTIFACT_CSP}"><meta charset="utf-8"><script>${BRIDGE}</script>${body}`;
}

/** Fichier .html téléchargé : la page telle que produite, avec la même CSP (aucune requête réseau à l'ouverture). */
export function buildDownloadDocument(code: string, title: string): string {
  const body = code.replace(/^\s*<!doctype[^>]*>/i, "");
  const safeTitle = title.replace(/[<>&"]/g, "");
  return `<!doctype html>\n<!-- ${safeTitle} — généré par IATrano -->\n<meta http-equiv="Content-Security-Policy" content="${ARTIFACT_CSP}">\n${body}\n`;
}

export function isBridgeMessage(data: unknown): data is BridgeMessage {
  return Boolean(data && typeof data === "object" && (data as Record<string, unknown>)[BRIDGE_TAG] === true);
}
