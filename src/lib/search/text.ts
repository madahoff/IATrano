// Outils lexicaux (français + anglais) pour le classement des passages : normalisation, mots vides, racinisation légère.

const STOPWORDS = new Set(
  `a à afin ai aie aient ainsi alors as au aucun aucune aujourd auprès aussi autre autres aux avait avant avec avoir ayant
  bon c ça car ce ceci cela celle celles celui cependant ces cet cette ceux chaque chez ci comme comment d dans de des depuis
  dès donc dont du elle elles en encore entre es est et étaient était été être eu eux fait faire fais fut il ils j je jusqu l la
  le les leur leurs lui m ma mais me même mes moi mon n ne ni nos notre nous on ont ou où par parce pas peu peut plus pour
  pourquoi qu quand que quel quelle quelles quels qui quoi s sa sans se ses si sien soit son sont sous suis sur t ta te tes
  toi ton tous tout toute toutes très tu un une vos votre vous y
  the of and to in is it that for on with as are was were be by this an at or from which but not have has had can will would
  what when where who how why do does did about into than then there their them they these those its your you we our i me my
  please svp merci peux pouvez dire donne donner explique expliquer cherche chercher recherche rechercher trouve trouver
  internet web google sources source infos info information informations`
    .split(/\s+/)
    .filter(Boolean),
);

export function fold(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

function stem(word: string): string {
  if (/^\d/.test(word)) return word;
  let w = word;
  if (w.length > 5) w = w.replace(/(ements|ement|ations|ation|ements|ments|ment|ities|ity|ings|ing|ers|er|es|s)$/, "");
  else if (w.length > 3) w = w.replace(/s$/, "");
  return w;
}

/** Termes indexables d'un texte : minuscules, sans accents, sans mots vides, racinisés. */
export function terms(text: string): string[] {
  const out: string[] = [];
  for (const raw of fold(text).split(/[^a-z0-9.+#-]+/)) {
    const t = raw.replace(/^[.\-+]+|[.\-]+$/g, "");
    if (t.length < 2 && !/^\d$/.test(t)) continue;
    if (STOPWORDS.has(t)) continue;
    out.push(stem(t));
  }
  return out;
}

/** Ensemble de « shingles » de 4 mots, pour détecter les passages quasi identiques. */
export function shingles(text: string, size = 4): Set<string> {
  const words = fold(text).split(/\W+/).filter(Boolean);
  const set = new Set<string>();
  for (let i = 0; i + size <= words.length; i++) set.add(words.slice(i, i + size).join(" "));
  return set;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

export function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}
