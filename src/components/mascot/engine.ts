// Moteur 3D de la mascotte « Trano » (three.js, navigateur uniquement — chargé à la demande).
//
// Le modèle est construit en code : superellipsoïdes lissées (tête, visière, corps), matériaux PBR
// (céramique vernie, verre fumé, accents bleus), éclairage d'environnement et ombre de contact.
// Il n'a pas de squelette : chaque pièce (tête, yeux, bouche, mains flottantes, antenne, capteurs)
// est animée directement. Les gestes de travail s'appuient sur de petits accessoires holographiques
// créés ici (clavier, page, orbe d'analyse, points observés) qui apparaissent et s'effacent en fondu.
//
// L'animation est procédurale : chaque état fournit une pose cible (qui peut osciller), et chaque
// paramètre la rejoint par un amortissement exponentiel — les transitions sont donc continues,
// quel que soit l'état de départ. Couches indépendantes : regard (pointeur, zones d'attention,
// toucher), clignements, antenne à ressort, frappes déclenchées par le texte réellement reçu (feed),
// hochements sur les étapes de recherche (nudge) et réaction au clic (poke).
import * as THREE from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { mergeVertices } from "three/addons/utils/BufferGeometryUtils.js";
import type { MascotState, SearchPhase } from "@/lib/mascot/state";

export type EngineOptions = {
  /** Appareil modeste : moins de polygones, résolution et cadence réduites. */
  lowPower?: boolean;
  /** Cadence maximale (images/s) ; les petites tailles n'ont pas besoin de 60 i/s. */
  maxFps?: number;
  reducedMotion?: boolean;
  dark?: boolean;
  /** « bust » : cadrage serré sur la tête, pour les petites tailles (le visage reste lisible). */
  framing?: "full" | "bust";
  /**
   * Suivi du regard : « full » (yeux, tête et corps suivent le pointeur — accueil),
   * « eyes » (regard seul, discret — fil de conversation), « none ».
   */
  gaze?: "full" | "eyes" | "none";
  /** Inertie du regard en secondes (constante de temps) : les yeux mènent, la tête suit. */
  eyeLag?: number;
  headLag?: number;
  /** Clic ou toucher sur la mascotte : petite réaction (et rappel, ex. son). */
  onPoke?: () => void;
  onContextLost?: () => void;
};

const ACCENT = new THREE.Color("#2f6ee6");
const EYE = new THREE.Color("#c9e6ff");
const EYE_GLOW = new THREE.Color("#3d8bff");
const HOLO = new THREE.Color("#5aa2ff");
/** Teinte plus soutenue en thème clair (les hologrammes passent devant le corps blanc). */
const HOLO_LIGHT = new THREE.Color("#2563eb");
const WARN = new THREE.Color("#ffb547");
const WARN_GLOW = new THREE.Color("#ff9a1f");

/** Le regard reste attentif tant que le pointeur a bougé (ou qu'on tape) dans ce délai. */
const ATTENTION_HOLD_MS = 2500;
const ATTENTION_ZONE = "[data-mascot-attention]";

// ---------------------------------------------------------------------------------------------
// Géométrie et textures

const spow = (x: number, e: number) => Math.sign(x) * Math.pow(Math.abs(x), e);

/**
 * Superellipsoïde fermée et lissée (exposants < 1 : formes plus « carrées »).
 * taper > 0 élargit le bas (silhouette en goutte).
 */
function superellipsoid(rx: number, ry: number, rz: number, e1: number, e2: number, seg: number, rings: number, taper = 0) {
  const pos: number[] = [];
  for (let i = 0; i <= rings; i++) {
    const u = -Math.PI / 2 + (i / rings) * Math.PI;
    const cu = spow(Math.cos(u), e1);
    const y = ry * spow(Math.sin(u), e1);
    const k = 1 - taper * (y / ry);
    for (let j = 0; j <= seg; j++) {
      // Couture placée à l'arrière (z négatif), invisible de face.
      const v = (j / seg) * Math.PI * 2;
      pos.push(rx * k * cu * spow(Math.sin(v), e2), y, -rz * k * cu * spow(Math.cos(v), e2));
    }
  }
  const index: number[] = [];
  for (let i = 0; i < rings; i++) {
    for (let j = 0; j < seg; j++) {
      const a = i * (seg + 1) + j;
      const b = a + seg + 1;
      index.push(a, a + 1, b, b, a + 1, b + 1);
    }
  }
  let g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(index);
  // Fusionne coutures et pôles pour des normales continues.
  g = mergeVertices(g, 1e-5);
  g.computeVertexNormals();
  // Orientation des faces : la normale d'un point de l'équateur doit pointer vers l'extérieur.
  const n = g.getAttribute("normal");
  const p = g.getAttribute("position");
  let probe = 0;
  for (let i = 0; i < p.count; i++) if (Math.abs(p.getY(i)) < ry * 0.05 && p.getZ(i) > 0) { probe = i; break; }
  if (n.getX(probe) * p.getX(probe) + n.getY(probe) * p.getY(probe) + n.getZ(probe) * p.getZ(probe) < 0) {
    const idx = g.getIndex()!;
    for (let i = 0; i < idx.count; i += 3) {
      const t = idx.getX(i + 1);
      idx.setX(i + 1, idx.getX(i + 2));
      idx.setX(i + 2, t);
    }
    g.computeVertexNormals();
  }
  return g;
}

function canvasTexture(w: number, h: number, draw: (ctx: CanvasRenderingContext2D) => void) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  draw(c.getContext("2d")!);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

const radialTexture = (inner: string, outer: string) =>
  canvasTexture(128, 128, (ctx) => {
    const grd = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    grd.addColorStop(0, inner);
    grd.addColorStop(1, outer);
    ctx.fillStyle = grd;
    ctx.fillRect(0, 0, 128, 128);
  });

/** Clavier holographique : contour et touches (trois rangées + barre d'espace). */
const keyboardTexture = () =>
  canvasTexture(256, 104, (ctx) => {
    ctx.strokeStyle = "rgba(255,255,255,0.95)";
    ctx.fillStyle = "rgba(255,255,255,0.12)";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.roundRect(3, 3, 250, 98, 14);
    ctx.fill();
    ctx.stroke();
    ctx.lineWidth = 2;
    const rows = [10, 9, 7];
    rows.forEach((n, r) => {
      const w = 20;
      const x0 = (256 - n * (w + 3)) / 2;
      for (let i = 0; i < n; i++) {
        ctx.beginPath();
        ctx.roundRect(x0 + i * (w + 3), 12 + r * 21, w, 17, 4);
        ctx.stroke();
      }
    });
    ctx.beginPath();
    ctx.roundRect(78, 76, 100, 15, 4);
    ctx.stroke();
  });

/** Page holographique : lignes de texte de longueurs variées, répétées pour défiler. */
const pageTexture = () => {
  const tex = canvasTexture(128, 256, (ctx) => {
    ctx.fillStyle = "rgba(255,255,255,0.9)";
    for (let i = 0; i < 16; i++) {
      const w = i % 5 === 4 ? 46 : 76 + ((i * 37) % 30);
      ctx.beginPath();
      ctx.roundRect(14, 8 + i * 15.5, w, 6, 3);
      ctx.fill();
    }
  });
  tex.wrapT = THREE.RepeatWrapping;
  return tex;
};

// ---------------------------------------------------------------------------------------------
// Pose

type Vec3 = [number, number, number];
type Pose = {
  rootY: number;
  lean: number;
  turn: number;
  tilt: number;
  squash: number;
  headYaw: number;
  headPitch: number;
  headRoll: number;
  lookX: number;
  lookY: number;
  eyeOpen: number;
  eyeScale: number;
  /** Taille de l'œil droit relative au gauche (perplexité, question). */
  eyeAsym: number;
  /** Œil droit relevé (sourcil interrogateur). */
  eyeRaise: number;
  eyeHappy: number;
  eyeSquint: number;
  mouthOpen: number;
  mouthWidth: number;
  smile: number;
  glow: number;
  earSpeed: number;
  warn: number;
  handL: Vec3;
  handR: Vec3;
  handLRot: number;
  handRRot: number;
  /** Opacité des accessoires holographiques. */
  holoKeys: number;
  holoPage: number;
  holoOrb: number;
  holoDots: number;
};

const NEUTRAL: Pose = {
  rootY: 0,
  lean: 0,
  turn: 0,
  tilt: 0,
  squash: 0,
  headYaw: 0,
  headPitch: 0,
  headRoll: 0,
  lookX: 0,
  lookY: 0,
  eyeOpen: 1,
  eyeScale: 1,
  eyeAsym: 1,
  eyeRaise: 0,
  eyeHappy: 0,
  eyeSquint: 0,
  mouthOpen: 0,
  mouthWidth: 1,
  smile: 0.3,
  glow: 0.45,
  earSpeed: 0,
  warn: 0,
  handL: [-0.68, -1.0, 0.1],
  handR: [0.68, -1.0, 0.1],
  handLRot: 0,
  handRRot: 0,
  holoKeys: 0,
  holoPage: 0,
  holoOrb: 0,
  holoDots: 0,
};

/** Vitesse de convergence par paramètre (1/s) : le regard est vif, le corps plus posé. */
const RATE: Partial<Record<keyof Pose, number>> = {
  lookX: 16,
  lookY: 16,
  eyeOpen: 14,
  mouthOpen: 20,
  mouthWidth: 14,
  headYaw: 6,
  headPitch: 6,
  headRoll: 5,
  turn: 4,
  tilt: 4,
  handL: 7,
  handR: 7,
  warn: 3,
  glow: 6,
  earSpeed: 3,
  holoKeys: 5,
  holoPage: 5,
  holoOrb: 5,
  holoDots: 4,
};

/** Bosse 0 → 1 → 0 sur [start, start + dur] (sinon 0). */
const bump = (s: number, start: number, dur: number) => (s < start || s > start + dur ? 0 : Math.sin(((s - start) / dur) * Math.PI));
const wave = (t: number, f: number, ph = 0) => Math.sin(t * f + ph);
/** Saturation douce : amplitude bornée, sans arrêt sec en bord d'écran. */
const soft = (x: number) => Math.tanh(x * 1.3);

type Gaze = {
  /** Cible lissée pour les yeux (rapide) et pour la tête et le corps (plus lent), dans [-1, 1]. */
  ex: number;
  ey: number;
  hx: number;
  hy: number;
  /** Attention portée à la cible (0 : repos ; 1 : suivi franc). */
  a: number;
};

type Ctx = {
  t: number;
  s: number;
  phase: SearchPhase;
  energy: number;
  gaze: Gaze;
  gazeMode: "full" | "eyes" | "none";
  saccade: { x: number; y: number };
  moving: boolean;
  /** Frappes en cours (0 → 1 → 0) de chaque main, déclenchées par le texte reçu. */
  tapL: number;
  tapR: number;
  /** Angle du point observé le plus en avant (balayage). */
  dotAngle: number;
};

function target(state: MascotState, c: Ctx): Pose {
  const { s, phase, energy: e, gaze: g, saccade: sc } = c;
  // Sans mouvement (prefers-reduced-motion) : poses figées, aucune oscillation.
  const t = c.moving ? c.t : 0;
  const m = c.moving ? 1 : 0;
  const float = 0.035 * wave(t, 1.05) * m;
  const breath = 0.012 * wave(t, 1.7) * m;
  const p: Pose = { ...NEUTRAL, rootY: float, squash: breath };
  p.handL = [-0.68, -1.0 + 0.025 * wave(t, 1.05, 0.6), 0.1];
  p.handR = [0.68, -1.0 + 0.025 * wave(t, 1.05, 1.4), 0.1];
  // Regard libre : yeux vers la cible ; tête et corps seulement en suivi complet.
  const full = c.gazeMode === "full";
  const followEyes = (k = 1) => {
    p.lookX = soft(g.ex) * 0.085 * Math.max(g.a, 0.35) * k + sc.x * (1 - g.a);
    p.lookY = soft(g.ey) * 0.05 * Math.max(g.a, 0.35) * k + sc.y * (1 - g.a);
  };

  switch (state) {
    case "idle": {
      const calm = 1 - 0.7 * g.a;
      p.headYaw = 0.1 * wave(t, 0.31) * calm + soft(g.hx) * (full ? 0.38 : 0.1) * g.a;
      p.headPitch = -0.03 + 0.03 * wave(t, 0.43) * calm - soft(g.hy) * (full ? 0.2 : 0.06) * g.a;
      p.headRoll = 0.035 * wave(t, 0.27) * calm + soft(g.hx) * 0.05 * g.a;
      if (full) {
        // Le corps accompagne légèrement la tête : rotation, inclinaison et penchée vers la cible.
        p.turn = soft(g.hx) * 0.12 * g.a;
        p.tilt = -soft(g.hx) * 0.03 * g.a;
        p.lean = -soft(g.hy) * 0.05 * g.a;
        p.smile = 0.3 + 0.15 * g.a;
      }
      followEyes();
      break;
    }

    case "listening":
      // Réaction immédiate : petit sursaut, puis tête tournée vers la saisie de l'utilisateur.
      p.rootY += 0.09 * bump(s, 0, 0.32) * m;
      p.lean = 0.07;
      p.headYaw = 0.3;
      p.headPitch = 0.04;
      p.headRoll = 0.13;
      p.lookX = 0.07;
      p.lookY = -0.03;
      p.eyeScale = 1.12;
      p.smile = 0.45;
      p.glow = 0.8;
      p.handL = [-0.6, -0.84, 0.24];
      p.handR = [0.6, -0.84, 0.24];
      break;

    case "thinking": {
      // Regard vers le haut, main au menton ; la lueur bat plus vite quand des jetons arrivent.
      const hm = bump((t % 2.6) / 2.6, 0.1, 0.12) * m;
      p.headPitch = -0.15 + 0.03 * wave(t, 0.9) + 0.05 * hm;
      p.headYaw = -0.16 + 0.1 * wave(t, 0.55);
      p.headRoll = -0.08;
      p.lookX = -0.05 + 0.03 * wave(t, 1.3);
      p.lookY = 0.065;
      p.eyeOpen = 0.86;
      p.eyeSquint = 0.15;
      p.smile = 0;
      p.mouthOpen = 0.12;
      p.mouthWidth = 0.55;
      p.glow = 0.45 + 0.4 * (0.5 + 0.5 * wave(t, 3 + 3 * e)) * (m || 0.5);
      p.handR = [0.3, -0.64, 0.56];
      p.handRRot = -0.5;
      break;
    }

    case "searching":
      p.earSpeed = phase === "scan" ? 9 : phase === "read" ? 3 : 1.6;
      p.eyeSquint = 0.22;
      p.smile = 0.1;
      if (phase === "scan") {
        // Exploration : des points lumineux gravitent autour de la tête ; le regard suit celui
        // qui passe devant, main en visière.
        const front = m ? Math.sin(c.dotAngle) : 0;
        p.holoDots = 1;
        p.headYaw = 0.36 * front;
        p.headPitch = -0.06;
        p.lookX = 0.09 * front;
        p.lookY = 0.015;
        p.eyeScale = 1.05;
        p.glow = 0.5 + 0.5 * Math.max(0, wave(t, 6)) * (m || 1);
        p.handL = [-0.66, 0.3, 0.72];
        p.handLRot = 1.1;
        p.turn = 0.06 * front;
      } else if (phase === "read") {
        // Lecture d'une page holographique tenue à deux mains : saccades ligne après ligne.
        const line = (t % 1.15) / 1.15;
        p.holoPage = 1;
        p.headPitch = 0.16;
        p.headYaw = 0.04 * wave(t, 0.7);
        p.lookX = m ? -0.075 + 0.15 * Math.min(1, line * 1.15) : 0;
        p.lookY = -0.05 - 0.015 * ((Math.floor(t / 1.15) % 3) / 2) * m;
        p.glow = 0.65;
        p.handL = [-0.36, -0.82, 0.84];
        p.handR = [0.36, -0.82, 0.84];
        p.handLRot = 0.5;
        p.handRRot = -0.5;
      } else {
        // Analyse : examen attentif d'un orbe holographique présenté de la main droite.
        p.holoOrb = 1;
        p.headYaw = 0.28 + 0.05 * wave(t, 0.8);
        p.headPitch = 0.07 + 0.03 * wave(t, 1.1);
        p.headRoll = 0.1;
        p.lookX = 0.065 + 0.012 * wave(t, 2.1);
        p.lookY = -0.03;
        p.eyeSquint = 0.3;
        p.glow = 0.5 + 0.35 * (0.5 + 0.5 * wave(t, 4.5)) * (m || 0.5);
        p.handR = [0.48, -0.62, 0.74];
        p.handRRot = 0.4;
      }
      break;

    case "generating": {
      // Rédaction : frappe sur un clavier holographique. Chaque frappe correspond à un fragment de
      // texte réellement reçu ; sans texte entrant, les mains restent en suspens au-dessus des touches.
      const talk = 0.35 + 0.65 * Math.abs(wave(t, 9.5) * wave(t, 3.7, 1));
      const up = m ? Math.pow(Math.max(0, wave(t, 0.8)), 4) : 0;
      p.holoKeys = 1;
      p.headPitch = 0.13 * (1 - up) - 0.03 * up + 0.015 * e * wave(t, 6) * m;
      p.headYaw = 0.05 * wave(t, 0.7);
      p.headRoll = 0.03 * wave(t, 1.3);
      p.lookX = 0.035 * wave(t, 2.3) * (1 - up);
      p.lookY = -0.045 * (1 - up) + 0.01 * up;
      p.smile = 0.2;
      p.mouthOpen = m ? e * talk * 0.5 : 0;
      p.mouthWidth = 0.7;
      p.glow = 0.7;
      p.handL = [-0.26 + 0.025 * wave(t, 1.3), -0.84 - 0.07 * c.tapL, 0.86];
      p.handR = [0.26 + 0.025 * wave(t, 1.1, 1), -0.84 - 0.07 * c.tapR, 0.86];
      p.handLRot = 0.3;
      p.handRRot = -0.3;
      break;
    }

    case "completed":
      // Fin : il range ses outils (fondu des hologrammes), relève la tête, sourit.
      p.rootY += 0.12 * bump(s, 0.05, 0.42) * m;
      p.squash -= 0.05 * bump(s, 0, 0.1) * m;
      p.eyeHappy = 1;
      p.smile = 1;
      p.headRoll = 0.12;
      p.headPitch = -0.06;
      followEyes(0.4);
      p.glow = 0.9;
      p.handL = [-0.76, -0.62, 0.16];
      p.handR = [0.76, -0.6 + 0.04 * wave(s, 12) * bump(s, 0.3, 1.0), 0.16];
      p.handRRot = 0.35 * wave(s, 12) * bump(s, 0.3, 1.0) * m;
      break;

    case "error":
      // Perplexité calme : secousse brève à l'entrée, puis immobilité (aucun signe d'activité).
      p.headRoll = -0.2;
      p.headPitch = 0.1;
      p.headYaw = -0.08 + 0.18 * Math.exp(-s * 3) * wave(s, 14) * m;
      p.eyeAsym = 0.72;
      p.lookY = -0.02;
      p.warn = 1;
      p.smile = 0;
      p.mouthOpen = 0.18;
      p.mouthWidth = 0.6;
      p.glow = 0.35;
      p.lean = -0.04;
      p.handL = [-0.64, -1.08, 0.05];
      p.handR = [0.64, -1.08, 0.05];
      break;

    case "asking":
      // Tête inclinée vers l'utilisateur, œil droit relevé : la mascotte attend une réponse.
      p.headRoll = 0.22;
      p.headYaw = 0.2;
      p.headPitch = -0.05;
      p.eyeAsym = 1.15;
      p.eyeRaise = 0.035;
      p.lookX = 0.05;
      p.lookY = -0.02;
      p.smile = 0;
      p.mouthOpen = 0.35;
      p.mouthWidth = 0.42;
      p.glow = 0.55 + 0.12 * wave(t, 1.5);
      p.handR = [0.74, -0.5, 0.2];
      p.handRRot = 0.5;
      break;
  }
  return p;
}

// ---------------------------------------------------------------------------------------------
// Moteur

export class MascotEngine {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(28, 1, 0.1, 50);
  private disposables: Array<{ dispose(): void }> = [];

  private root = new THREE.Group();
  private headPivot = new THREE.Group();
  private antennaPivot = new THREE.Group();
  private eyes: THREE.Group[] = [];
  private eyeCaps: THREE.Mesh[] = [];
  private eyeArcs: THREE.Mesh[] = [];
  private eyeGlows: THREE.Mesh[] = [];
  private ears: THREE.Group[] = [];
  private mouth!: THREE.Mesh;
  private smileArc!: THREE.Mesh;
  private handL!: THREE.Mesh;
  private handR!: THREE.Mesh;
  private shadow!: THREE.Mesh;
  private eyeMat!: THREE.MeshBasicMaterial;
  private glowMat!: THREE.MeshBasicMaterial;
  private beadMat!: THREE.MeshStandardMaterial;
  private chestMat!: THREE.MeshStandardMaterial;
  private shadowMat!: THREE.MeshBasicMaterial;
  private rim!: THREE.DirectionalLight;
  private shadowBase = 0.22;

  // Accessoires holographiques.
  private keyboard!: THREE.Mesh;
  private keyMat!: THREE.MeshBasicMaterial;
  private page!: THREE.Mesh;
  private pageMat!: THREE.MeshBasicMaterial;
  private pageTex!: THREE.Texture;
  private orb!: THREE.Group;
  private orbMat!: THREE.LineBasicMaterial;
  private orbCoreMat!: THREE.MeshBasicMaterial;
  private dots: THREE.Mesh[] = [];
  private dotMat!: THREE.MeshBasicMaterial;
  private holoMats: Array<THREE.MeshBasicMaterial | THREE.LineBasicMaterial> = [];

  private pose: Pose = structuredClone(NEUTRAL);
  private state: MascotState = "idle";
  private phase: SearchPhase = "scan";
  private stateStart = 0;
  private clock = 0;
  private energy = 0;
  private nodAt = -10;
  private pokeAt = -10;
  private blinkAt = -10;
  private nextBlink = 2;
  private doubleBlink = false;
  private saccade = { x: 0, y: 0 };
  private nextSaccade = 1;
  private antenna = { x: 0, z: 0, vx: 0, vz: 0, slowRoll: 0, slowPitch: 0, prevY: 0 };
  private earAngle = 0;
  private dotAngle = 0;
  private tapAt: [number, number] = [-10, -10];
  private tapSide = 0;

  // Regard : position brute (coordonnées fenêtre), zone d'attention survolée, cible lissée.
  private gazeMode: "full" | "eyes" | "none";
  private eyeLag: number;
  private headLag: number;
  private raw: { x: number; y: number } | null = null;
  private zone: Element | null = null;
  private gazeDirty = false;
  private gazeGoal = { x: 0, y: 0 };
  private lastInput = -Infinity;
  private glance = { x: 0, y: 0, next: 0 };
  private noHover: boolean;
  private gaze: Gaze = { ex: 0, ey: 0, hx: 0, hy: 0, a: 0 };

  private running = false;
  private visible = true;
  private frame: number | null = null;
  private lastTick = 0;
  private lastRender = 0;
  private reducedMotion: boolean;
  private maxFps: number;
  private disposed = false;

  constructor(
    private canvas: HTMLCanvasElement,
    private opts: EngineOptions = {},
  ) {
    this.reducedMotion = Boolean(opts.reducedMotion);
    this.maxFps = opts.maxFps ?? 60;
    this.gazeMode = opts.gaze ?? "eyes";
    this.eyeLag = opts.eyeLag ?? 0.08;
    this.headLag = opts.headLag ?? 0.35;
    this.noHover = window.matchMedia("(hover: none)").matches;
    this.renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: "low-power" });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, opts.lowPower ? 1.5 : 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    canvas.addEventListener("webglcontextlost", this.onContextLost);

    if (opts.framing === "bust") {
      this.camera.position.set(0, 0.2, 4.7);
      this.camera.lookAt(0, -0.12, 0);
    } else {
      this.camera.position.set(0, 0.15, 7.2);
      this.camera.lookAt(0, -0.3, 0);
    }

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const room = new RoomEnvironment();
    const env = pmrem.fromScene(room, 0.04).texture;
    room.dispose();
    pmrem.dispose();
    this.disposables.push(env);
    this.scene.environment = env;
    this.scene.environmentIntensity = 0.55;

    const key = new THREE.DirectionalLight(0xffffff, 1.7);
    key.position.set(-2.5, 3.5, 4);
    this.rim = new THREE.DirectionalLight(0x9ec5ff, 1.3);
    this.rim.position.set(3, 1.5, -3);
    this.scene.add(key, this.rim, new THREE.HemisphereLight(0xffffff, 0xd5dbe6, 0.5));

    this.build(opts.lowPower ? 0.55 : 1);
    this.setTheme(Boolean(opts.dark));
    if (this.gazeMode !== "none") {
      window.addEventListener("pointermove", this.onPointerMove, { passive: true });
      window.addEventListener("pointerdown", this.onPointerDown, { passive: true });
      document.addEventListener("keydown", this.onKeyDown, { passive: true });
    }
    if (opts.onPoke) canvas.addEventListener("pointerdown", this.onPoke);
  }

  private track<T extends { dispose(): void }>(r: T): T {
    this.disposables.push(r);
    return r;
  }

  private build(detail: number) {
    const seg = Math.round(72 * detail);
    const rings = Math.round(48 * detail);

    const ceramic = this.track(new THREE.MeshPhysicalMaterial({ color: "#eef1f6", roughness: 0.36, clearcoat: 0.7, clearcoatRoughness: 0.22, sheen: 0.3, sheenColor: new THREE.Color("#dfe8ff") }));
    const visorMat = this.track(new THREE.MeshPhysicalMaterial({ color: "#0b0e15", roughness: 0.12, metalness: 0.15, clearcoat: 1, clearcoatRoughness: 0.04 }));
    const trim = this.track(new THREE.MeshStandardMaterial({ color: "#1c2029", roughness: 0.45, metalness: 0.2 }));
    const accent = this.track(new THREE.MeshPhysicalMaterial({ color: ACCENT, roughness: 0.3, clearcoat: 0.6, clearcoatRoughness: 0.2 }));
    const metal = this.track(new THREE.MeshStandardMaterial({ color: "#8a93a3", roughness: 0.3, metalness: 0.7 }));
    this.eyeMat = this.track(new THREE.MeshBasicMaterial({ color: EYE.clone(), toneMapped: false }));
    const glowTex = this.track(radialTexture("rgba(255,255,255,0.9)", "rgba(255,255,255,0)"));
    this.glowMat = this.track(new THREE.MeshBasicMaterial({ map: glowTex, color: EYE_GLOW.clone(), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
    this.beadMat = this.track(new THREE.MeshStandardMaterial({ color: ACCENT, emissive: EYE_GLOW.clone(), emissiveIntensity: 1, roughness: 0.25 }));
    this.chestMat = this.track(new THREE.MeshStandardMaterial({ color: "#10131a", emissive: EYE_GLOW.clone(), emissiveIntensity: 1, roughness: 0.3 }));

    // --- Corps : goutte légèrement évasée, anneau de cou et voyant de poitrine.
    const body = new THREE.Mesh(this.track(superellipsoid(0.54, 0.44, 0.47, 0.72, 0.8, seg, rings, 0.16)), ceramic);
    body.position.y = -0.98;
    const neck = new THREE.Mesh(this.track(new THREE.TorusGeometry(0.34, 0.05, 12, Math.round(48 * detail))), trim);
    neck.rotation.x = Math.PI / 2;
    neck.position.y = -0.6;
    const chest = new THREE.Mesh(this.track(new THREE.CircleGeometry(0.055, 24)), this.chestMat);
    chest.position.set(0, -0.86, 0.505);
    chest.rotation.x = -0.32;
    this.root.add(body, neck, chest);

    // --- Mains flottantes (moufles).
    const handGeo = this.track(new THREE.CapsuleGeometry(0.11, 0.1, 6, Math.round(20 * detail)));
    this.handL = new THREE.Mesh(handGeo, ceramic);
    this.handR = new THREE.Mesh(handGeo, ceramic);
    this.handL.scale.set(1, 1, 0.85);
    this.handR.scale.set(1, 1, 0.85);
    this.root.add(this.handL, this.handR);

    // --- Tête : squircle en céramique, visière en verre fumé incrustée.
    const head = new THREE.Mesh(this.track(superellipsoid(0.8, 0.6, 0.6, 0.55, 0.6, seg, rings)), ceramic);
    const visor = new THREE.Mesh(this.track(superellipsoid(0.62, 0.39, 0.3, 0.45, 0.55, seg, rings)), visorMat);
    visor.position.set(0, -0.01, 0.37);
    this.headPivot.add(head, visor);
    this.headPivot.position.y = -0.02;

    // Yeux : capsules lumineuses + arcs « joyeux » + halo additif.
    const capGeo = this.track(new THREE.CapsuleGeometry(0.068, 0.12, 6, 16));
    const arcGeo = this.track(new THREE.TorusGeometry(0.095, 0.034, 10, 32, Math.PI));
    const glowGeo = this.track(new THREE.PlaneGeometry(0.62, 0.62));
    for (const side of [-1, 1]) {
      const g = new THREE.Group();
      g.position.set(side * 0.22, 0.04, 0.676);
      const cap = new THREE.Mesh(capGeo, this.eyeMat);
      const arc = new THREE.Mesh(arcGeo, this.eyeMat);
      arc.position.y = -0.03;
      const glow = new THREE.Mesh(glowGeo, this.glowMat);
      glow.position.z = -0.006;
      g.add(glow, cap, arc);
      this.headPivot.add(g);
      this.eyes.push(g);
      this.eyeCaps.push(cap);
      this.eyeArcs.push(arc);
      this.eyeGlows.push(glow);
    }
    // Bouche : trait (parole, « o ») et arc (sourire).
    this.mouth = new THREE.Mesh(this.track(new THREE.CapsuleGeometry(0.028, 0.1, 4, 12)), this.eyeMat);
    this.mouth.rotation.z = Math.PI / 2;
    this.mouth.position.set(0, -0.19, 0.668);
    this.smileArc = new THREE.Mesh(this.track(new THREE.TorusGeometry(0.075, 0.02, 8, 24, Math.PI)), this.eyeMat);
    this.smileArc.rotation.z = Math.PI;
    this.smileArc.position.set(0, -0.145, 0.668);
    this.headPivot.add(this.mouth, this.smileArc);

    // Oreilles : capteurs circulaires qui tournent pendant les recherches (barrette visible).
    for (const side of [-1, 1]) {
      const ear = new THREE.Group();
      ear.position.set(side * 0.79, 0.02, 0);
      const disc = new THREE.Mesh(this.track(new THREE.CylinderGeometry(0.19, 0.19, 0.1, Math.round(40 * detail))), accent);
      disc.rotation.z = Math.PI / 2;
      const ring = new THREE.Mesh(this.track(new THREE.TorusGeometry(0.13, 0.018, 8, 32)), trim);
      ring.rotation.y = Math.PI / 2;
      ring.position.x = side * 0.052;
      const bar = new THREE.Mesh(this.track(new THREE.BoxGeometry(0.02, 0.2, 0.045)), trim);
      bar.position.x = side * 0.052;
      const spinner = new THREE.Group();
      spinner.add(ring, bar);
      ear.add(disc, spinner);
      this.headPivot.add(ear);
      this.ears.push(spinner);
    }

    // Antenne : tige souple et perle lumineuse (ressort amorti).
    this.antennaPivot.position.set(0.12, 0.58, -0.02);
    this.antennaPivot.rotation.z = -0.12;
    const stem = new THREE.Mesh(this.track(new THREE.CylinderGeometry(0.018, 0.024, 0.3, 10)), metal);
    stem.position.y = 0.15;
    const bead = new THREE.Mesh(this.track(new THREE.SphereGeometry(0.075, 24, 16)), this.beadMat);
    bead.position.y = 0.33;
    this.antennaPivot.add(stem, bead);
    this.headPivot.add(this.antennaPivot);

    this.root.add(this.headPivot);
    this.buildHolograms();
    this.scene.add(this.root);

    // Ombre de contact (dégradé radial), plus discrète quand la mascotte s'élève.
    this.shadowMat = this.track(new THREE.MeshBasicMaterial({ map: this.track(radialTexture("rgba(0,0,0,1)", "rgba(0,0,0,0)")), transparent: true, depthWrite: false }));
    this.shadow = new THREE.Mesh(this.track(new THREE.PlaneGeometry(1.7, 0.7)), this.shadowMat);
    this.shadow.rotation.x = -Math.PI / 2;
    this.shadow.position.y = -1.47;
    this.scene.add(this.shadow);
  }

  /** Accessoires de travail : hologrammes bleus translucides, invisibles (et non dessinés) au repos. */
  private buildHolograms() {
    const holo = (map?: THREE.Texture) =>
      this.track(new THREE.MeshBasicMaterial({ map, color: HOLO.clone(), transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide, toneMapped: false }));

    this.keyMat = holo(this.track(keyboardTexture()));
    this.keyboard = new THREE.Mesh(this.track(new THREE.PlaneGeometry(1.0, 0.41)), this.keyMat);
    this.keyboard.position.set(0, -0.98, 0.8);
    this.keyboard.rotation.x = -0.85;

    this.pageTex = this.track(pageTexture());
    this.pageMat = holo(this.pageTex);
    this.page = new THREE.Mesh(this.track(new THREE.PlaneGeometry(0.6, 0.44)), this.pageMat);
    this.page.position.set(0, -0.66, 0.9);
    this.page.rotation.x = -0.45;

    this.orb = new THREE.Group();
    this.orb.position.set(0.5, -0.36, 0.78);
    this.orbMat = this.track(new THREE.LineBasicMaterial({ color: HOLO.clone(), transparent: true, opacity: 0, depthWrite: false, toneMapped: false }));
    const ico = this.track(new THREE.IcosahedronGeometry(0.15, 1));
    const edges = new THREE.LineSegments(this.track(new THREE.EdgesGeometry(ico)), this.orbMat);
    this.orbCoreMat = holo(this.track(radialTexture("rgba(255,255,255,1)", "rgba(255,255,255,0)")));
    const core = new THREE.Mesh(this.track(new THREE.PlaneGeometry(0.34, 0.34)), this.orbCoreMat);
    this.orb.add(edges, core);

    this.dotMat = holo(this.track(radialTexture("rgba(255,255,255,1)", "rgba(255,255,255,0)")));
    const dotGeo = this.track(new THREE.PlaneGeometry(0.2, 0.2));
    for (let i = 0; i < 3; i++) this.dots.push(new THREE.Mesh(dotGeo, this.dotMat));

    this.holoMats = [this.keyMat, this.pageMat, this.orbMat, this.orbCoreMat, this.dotMat];
    this.root.add(this.keyboard, this.page, this.orb, ...this.dots);
  }

  // --- API

  setState(state: MascotState, phase: SearchPhase = "scan") {
    if (state === this.state && phase === this.phase) return;
    if (state !== this.state) this.stateStart = this.clock;
    this.state = state;
    this.phase = phase;
    if (this.reducedMotion) this.renderStill();
  }

  /** Nouveau texte reçu en streaming : énergie de parole et, en rédaction, une frappe. */
  feed() {
    this.energy = Math.min(1, this.energy + 0.35);
    if (this.state === "generating" && this.clock - Math.max(...this.tapAt) > 0.085) {
      this.tapSide ^= 1;
      this.tapAt[this.tapSide] = this.clock;
    }
  }

  /** Étape réelle franchie (ex. recherche) : petit hochement de tête. */
  nudge() {
    this.nodAt = this.clock;
  }

  setTheme(dark: boolean) {
    this.rim.intensity = dark ? 1.8 : 1.1;
    this.shadowBase = dark ? 0.55 : 0.22;
    for (const m of this.holoMats) m.color.copy(dark ? HOLO : HOLO_LIGHT);
    if (!this.running) this.renderNow();
  }

  setReducedMotion(reduced: boolean) {
    this.reducedMotion = reduced;
    this.sync();
  }

  setVisible(visible: boolean) {
    this.visible = visible;
    this.sync();
  }

  resize(width: number, height: number) {
    if (width <= 0 || height <= 0) return;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    if (!this.running) this.renderNow();
  }

  /** Pose figée de l'état courant, sans mouvement (préférence de réduction des animations). */
  renderStill() {
    this.gaze = { ex: 0, ey: 0, hx: 0, hy: 0, a: 0 };
    this.pose = target(this.state, this.ctx(false));
    this.antenna.x = this.antenna.z = this.antenna.vx = this.antenna.vz = 0;
    this.apply(1);
    this.renderNow();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.stop();
    window.removeEventListener("pointermove", this.onPointerMove);
    window.removeEventListener("pointerdown", this.onPointerDown);
    document.removeEventListener("keydown", this.onKeyDown);
    this.canvas.removeEventListener("pointerdown", this.onPoke);
    this.canvas.removeEventListener("webglcontextlost", this.onContextLost);
    for (const d of this.disposables) d.dispose();
    this.renderer.dispose();
    // Libère le contexte WebGL tout de suite (les navigateurs en limitent le nombre).
    this.renderer.forceContextLoss();
  }

  // --- Boucle

  private sync() {
    if (this.disposed) return;
    if (this.reducedMotion) {
      this.stop();
      this.renderStill();
    } else if (this.visible) this.start();
    else this.stop();
  }

  private start() {
    if (this.running) return;
    this.running = true;
    this.lastTick = performance.now();
    this.frame = requestAnimationFrame(this.tick);
  }

  private stop() {
    this.running = false;
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
  }

  private tick = (now: number) => {
    if (!this.running) return;
    this.frame = requestAnimationFrame(this.tick);
    if (now - this.lastRender < 1000 / this.maxFps - 2) return;
    // Onglet masqué puis revenu : pas de rattrapage brutal. L'horodatage rAF peut précéder
    // performance.now() lu au démarrage : un pas négatif ferait diverger les ressorts.
    const dt = Math.min(0.05, Math.max(0, (now - this.lastTick) / 1000));
    this.lastTick = now;
    this.lastRender = now;
    this.update(dt);
    this.renderNow();
  };

  private ctx(moving: boolean): Ctx {
    return {
      t: this.clock,
      s: this.clock - this.stateStart,
      phase: this.phase,
      energy: this.energy,
      gaze: this.gaze,
      gazeMode: this.gazeMode,
      saccade: this.saccade,
      moving,
      tapL: bump(this.clock - this.tapAt[0], 0, 0.13),
      tapR: bump(this.clock - this.tapAt[1], 0, 0.13),
      dotAngle: this.frontDotAngle(),
    };
  }

  private update(dt: number) {
    this.clock += dt;
    this.energy *= Math.exp(-dt * 1.6);
    this.dotAngle += dt * 1.15;
    this.scheduleEyes();
    this.updateGaze(dt);

    const goal = target(this.state, this.ctx(true));
    goal.headPitch += 0.08 * bump(this.clock - this.nodAt, 0, 0.36);
    // Réaction au clic : petit bond, yeux rieurs.
    const dp = this.clock - this.pokeAt;
    if (dp < 0.9) {
      goal.rootY += 0.08 * bump(dp, 0, 0.32);
      goal.squash -= 0.04 * bump(dp, 0, 0.1);
      if (this.state === "idle") goal.eyeHappy = Math.max(goal.eyeHappy, bump(dp, 0, 0.9));
    }
    const cur = this.pose as Record<keyof Pose, number | Vec3>;
    for (const k of Object.keys(goal) as Array<keyof Pose>) {
      const a = 1 - Math.exp(-dt * (RATE[k] ?? 7));
      const g = goal[k];
      if (Array.isArray(g)) {
        const v = cur[k] as Vec3;
        for (let i = 0; i < 3; i++) v[i] += (g[i] - v[i]) * a;
      } else cur[k] = (cur[k] as number) + (g - (cur[k] as number)) * a;
    }
    this.updateAntenna(dt);
    this.earAngle += this.pose.earSpeed * dt;
    this.orb.rotation.y += dt * 0.9;
    this.orb.rotation.x += dt * 0.45;
    this.pageTex.offset.y = (this.clock * 0.09) % 1;
    this.apply(this.blinkFactor());
  }

  /**
   * Regard à deux étages : la cible brute (pointeur, zone d'attention ou point touché) est
   * convertie en coordonnées relatives à la mascotte, puis lissée vite pour les yeux et
   * lentement pour la tête et le corps. Sans interaction récente, l'attention retombe et
   * l'animation de repos reprend ; sur écran tactile, des coups d'œil spontanés la remplacent.
   */
  private updateGaze(dt: number) {
    if (this.gazeDirty && this.raw) {
      this.gazeDirty = false;
      const r = this.canvas.getBoundingClientRect();
      let x = this.raw.x;
      let y = this.raw.y;
      if (this.zone?.isConnected) {
        // Zone importante survolée : l'attention se porte surtout vers son centre.
        const z = this.zone.getBoundingClientRect();
        x = x * 0.35 + (z.left + z.width / 2) * 0.65;
        y = y * 0.35 + (z.top + z.height / 2) * 0.65;
      }
      this.gazeGoal.x = Math.max(-1.5, Math.min(1.5, (x - (r.left + r.width / 2)) / (window.innerWidth / 2)));
      this.gazeGoal.y = Math.max(-1.5, Math.min(1.5, (r.top + r.height / 2 - y) / (window.innerHeight / 2)));
    }
    const active = this.gazeMode !== "none" && performance.now() - this.lastInput < ATTENTION_HOLD_MS;
    let goal = this.gazeGoal;
    let attention = active ? 1 : 0.12;
    if (!active && this.noHover && this.gazeMode === "full") {
      // Pas de souris : coups d'œil curieux de temps en temps.
      if (this.clock >= this.glance.next) {
        const look = Math.random() < 0.6;
        this.glance = { x: look ? (Math.random() - 0.5) * 1.6 : 0, y: look ? (Math.random() - 0.4) * 0.8 : 0, next: this.clock + 3 + Math.random() * 3.5 };
      }
      goal = this.glance;
      attention = 0.5;
    }
    if (this.gazeMode === "none") attention = 0;
    const g = this.gaze;
    g.a += (attention - g.a) * (1 - Math.exp(-dt * (attention > g.a ? 3 : 0.8)));
    const ke = 1 - Math.exp(-dt / this.eyeLag);
    const kh = 1 - Math.exp(-dt / this.headLag);
    g.ex += (goal.x - g.ex) * ke;
    g.ey += (goal.y - g.ey) * ke;
    g.hx += (goal.x - g.hx) * kh;
    g.hy += (goal.y - g.hy) * kh;
  }

  private frontDotAngle() {
    // Le point le plus en avant parmi trois, répartis à 120° les uns des autres.
    const base = this.dotAngle;
    let best = base;
    for (let i = 0; i < 3; i++) {
      const a = base + (i * Math.PI * 2) / 3;
      if (Math.cos(a) > Math.cos(best)) best = a;
    }
    return best;
  }

  private scheduleEyes() {
    const c = this.clock;
    if (c >= this.nextBlink) {
      this.blinkAt = c;
      this.doubleBlink = Math.random() < 0.15;
      const [min, span] = this.state === "thinking" ? [4, 3] : this.state === "searching" ? [1.6, 1.6] : [2.4, 4];
      this.nextBlink = c + min + Math.random() * span;
    }
    if (c >= this.nextSaccade) {
      const roam = this.state === "idle";
      this.saccade = roam ? { x: (Math.random() - 0.5) * 0.07, y: (Math.random() - 0.5) * 0.04 } : { x: 0, y: 0 };
      this.nextSaccade = c + 1.4 + Math.random() * 2.6;
    }
  }

  private blinkFactor() {
    if (this.state === "completed") return 1;
    const once = (s: number) => (s < 0 ? 1 : s < 0.07 ? 1 - s / 0.07 : s < 0.16 ? (s - 0.07) / 0.09 : 1);
    const s = this.clock - this.blinkAt;
    return Math.max(0.06, Math.min(once(s), this.doubleBlink ? once(s - 0.22) : 1));
  }

  /** Antenne : ressort sous-amorti entraîné par l'inertie de la tête et les sauts. */
  private updateAntenna(dt: number) {
    const a = this.antenna;
    const lag = 1 - Math.exp(-dt * 4);
    a.slowRoll += (this.pose.headRoll + this.pose.headYaw * 0.3 - a.slowRoll) * lag;
    a.slowPitch += (this.pose.headPitch - a.slowPitch) * lag;
    const vy = (this.pose.rootY - a.prevY) / Math.max(dt, 1e-3);
    a.prevY = this.pose.rootY;
    const tz = -(this.pose.headRoll + this.pose.headYaw * 0.3 - a.slowRoll) * 1.6;
    const tx = -(this.pose.headPitch - a.slowPitch) * 1.4 + vy * 0.12;
    const k = 140;
    const damping = 7;
    a.vz += (k * (tz - a.z) - damping * a.vz) * dt;
    a.vx += (k * (tx - a.x) - damping * a.vx) * dt;
    a.z += a.vz * dt;
    a.x += a.vx * dt;
  }

  private apply(blink: number) {
    const p = this.pose;
    this.root.position.y = p.rootY;
    this.root.rotation.set(p.lean, p.turn, p.tilt);
    this.root.scale.set(1 - p.squash * 0.5, 1 + p.squash, 1 - p.squash * 0.5);
    this.headPivot.rotation.set(p.headPitch, p.headYaw, p.headRoll, "YXZ");

    const open = p.eyeOpen * blink * (1 - p.eyeSquint * 0.45) * (1 - p.eyeHappy);
    this.eyes.forEach((g, i) => {
      const right = i === 1;
      const size = p.eyeScale * (right ? p.eyeAsym : 1);
      g.position.x = (right ? 0.22 : -0.22) + p.lookX;
      g.position.y = 0.04 + p.lookY + (right ? p.eyeRaise : 0);
      this.eyeCaps[i].scale.set(size * (1 + p.eyeSquint * 0.15), Math.max(0.001, size * open), 1);
      const happy = Math.max(0.001, p.eyeHappy * size);
      this.eyeArcs[i].scale.set(happy, happy, happy);
      this.eyeGlows[i].scale.setScalar(size * (0.7 + 0.5 * p.glow));
    });
    const talk = Math.max(0, p.mouthOpen);
    this.mouth.visible = talk > 0.02;
    this.mouth.scale.set(0.6 + talk * 2.2, p.mouthWidth, 1);
    this.mouth.position.x = p.lookX * 0.5;
    const smile = Math.max(0, p.smile - talk * 1.5);
    this.smileArc.visible = smile > 0.02;
    this.smileArc.scale.set(0.5 + smile * 0.6, 0.35 + smile * 0.75, 1);
    this.smileArc.position.x = p.lookX * 0.5;

    this.handL.position.set(...p.handL);
    this.handR.position.set(...p.handR);
    this.handL.rotation.z = p.handLRot;
    this.handR.rotation.z = p.handRRot;
    this.ears.forEach((e, i) => (e.rotation.x = this.earAngle * (i ? 1 : -1)));
    this.antennaPivot.rotation.set(this.antenna.x, 0, -0.12 + this.antenna.z);

    const w = Math.min(1, Math.max(0, p.warn));
    this.eyeMat.color.copy(EYE).lerp(WARN, w);
    this.glowMat.color.copy(EYE_GLOW).lerp(WARN_GLOW, w).multiplyScalar(0.35 + 0.65 * p.glow);
    this.beadMat.color.copy(ACCENT).lerp(WARN_GLOW, w);
    this.beadMat.emissive.copy(EYE_GLOW).lerp(WARN_GLOW, w);
    this.beadMat.emissiveIntensity = 0.35 + 1.6 * p.glow;
    this.chestMat.emissive.copy(EYE_GLOW).lerp(WARN_GLOW, w);
    this.chestMat.emissiveIntensity = 0.2 + 1.4 * p.glow;

    // Hologrammes : opacité amortie ; la touche frappée fait briller le clavier.
    const flash = Math.max(bump(this.clock - this.tapAt[0], 0, 0.13), bump(this.clock - this.tapAt[1], 0, 0.13));
    this.keyMat.opacity = p.holoKeys * (0.5 + 0.35 * flash);
    this.keyboard.visible = p.holoKeys > 0.01;
    this.pageMat.opacity = p.holoPage * 0.7;
    this.page.visible = p.holoPage > 0.01;
    this.orbMat.opacity = p.holoOrb * 0.9;
    this.orbCoreMat.opacity = p.holoOrb * (0.35 + 0.2 * Math.sin(this.clock * 4));
    this.orb.visible = p.holoOrb > 0.01;
    this.orb.scale.setScalar(0.6 + 0.4 * p.holoOrb);
    this.dotMat.opacity = p.holoDots * 0.95;
    this.dots.forEach((d, i) => {
      const a = this.dotAngle + (i * Math.PI * 2) / 3;
      d.visible = p.holoDots > 0.01;
      d.position.set(Math.sin(a) * 1.08, 0.12 + 0.1 * Math.sin(a * 2 + i), Math.cos(a) * 0.9);
    });

    const lift = Math.max(0, p.rootY);
    this.shadow.scale.setScalar(1 - lift * 1.6);
    this.shadowMat.opacity = this.shadowBase * (1 - lift * 1.5);
  }

  private renderNow() {
    if (this.disposed) return;
    this.renderer.render(this.scene, this.camera);
  }

  // --- Entrées : aucun rendu React, seulement des valeurs lues à l'image suivante.

  private onPointerMove = (e: PointerEvent) => {
    if (e.pointerType === "touch") return;
    this.raw = { x: e.clientX, y: e.clientY };
    this.zone = e.target instanceof Element ? e.target.closest(ATTENTION_ZONE) : null;
    this.gazeDirty = true;
    this.lastInput = performance.now();
  };

  private onPointerDown = (e: PointerEvent) => {
    if (e.pointerType !== "touch") return;
    // Écran tactile : la mascotte regarde l'endroit touché, puis se stabilise.
    this.raw = { x: e.clientX, y: e.clientY };
    this.zone = null;
    this.gazeDirty = true;
    this.lastInput = performance.now();
  };

  private onKeyDown = () => {
    // Saisie dans une zone importante (ex. message en cours d'écriture) : la mascotte la regarde.
    const el = document.activeElement?.closest(ATTENTION_ZONE);
    if (!el) return;
    const r = el.getBoundingClientRect();
    this.raw = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    this.zone = null;
    this.gazeDirty = true;
    this.lastInput = performance.now();
  };

  private onPoke = () => {
    if (this.clock - this.pokeAt < 0.6) return;
    this.pokeAt = this.clock;
    this.opts.onPoke?.();
  };

  private onContextLost = (e: Event) => {
    e.preventDefault();
    this.stop();
    this.opts.onContextLost?.();
  };
}
