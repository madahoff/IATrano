// Décision serveur : faut-il chercher sur le Web pour ce message ? Règles explicites et testables
// (aucune dépendance au modèle, donc aucun appel supplémentaire pour les questions simples).
import { fold } from "./text";
import type { ResearchMode } from "./research-types";

export type SearchDecision =
  | { search: false; reason: string }
  | { search: true; mode: ResearchMode; reason: string; timeSensitive: boolean; freshness?: "week" | "month" | "year" };

const EXPLICIT = [
  /\b(cherche|recherche|regarde|verifie|trouve|consulte|fouille)s?r?\b[^.?!]{0,40}\b(internet|web|en ligne|google|net|sources?)\b/,
  /\b(sur|via|depuis) (internet|le web|le net|google)\b/,
  /\b(search|look up|browse|google)\b[^.?!]{0,30}\b(web|internet|online|for)\b/,
  /\b(search the web|web search|recherche web|recherche internet)\b/,
  /\b(avec|donne|cite|ajoute|indique)[^.?!]{0,25}\b(sources?|references?|liens?)\b/,
  /\b(with|cite|give)[^.?!]{0,20}\b(sources?|references|citations)\b/,
  /\bsources? (fiables?|officielles?|recentes?)\b/,
];

const RECENCY = [
  /\b(actualites?|news|nouvelles?|nouveautes?|breaking)\b/,
  /\b(aujourd ?hui|hier|cette semaine|ce mois|cette annee|ce week-end|en ce moment|actuellement|maintenant|today|yesterday|this week|this month|this year|right now|currently)\b/,
  /\b(recents?|recentes?|recemment|dernier|derniere|derniers|dernieres|latest|newest|recent|recently|a jour|up to date|mise a jour|updated?)\b/,
  /\b(sorti|sortie|sortis|released?|annonces?|announced|lancement|launch(ed)?)\b/,
];

const VOLATILE = [
  /\b(prix|tarifs?|cout|coute|couts|combien coute|price|pricing|cost)\b/,
  /\b(cours de|taux de change|bourse|action [a-z]+|stock price|exchange rate|crypto|bitcoin)\b/,
  /\b(meteo|weather|previsions?)\b/,
  /\b(score|resultats? du match|classement|standings|qui a gagne|who won)\b/,
  /\b(elections?|sondages?|president actuel|premier ministre|gouvernement|pdg|ceo|dirigeant)\b/,
  /\b(versions?|changelog|release notes|notes de version|roadmap|deprecated|deprecie|obsolete)\b/,
  /\b(documentation|docs officielles?|doc officielle|api reference|reference api)\b/,
  /\b(loi|decret|reglementation|regulation|legislation|jurisprudence)\b/,
  /\b(horaires?|disponibilite|en stock|ouvert|ferme)\b/,
  /\b(population|statistiques?|chiffres? (cles|officiels)|pib|gdp|inflation|chomage)\b/,
];

const DEEP = [
  /\b(compare[rz]?|comparaison|comparatif|versus|vs\.?|difference[s]? entre|meilleure?s?|top \d+|avantages et inconvenients|pour et contre|alternatives?|benchmark)\b/,
  /\b(plusieurs sources|en detail|approfondi[e]?|etat de l art|synthese|tour d horizon|controverse|debat)\b/,
];

const NO_SEARCH = [
  /^(bonjour|salut|hello|hi|hey|coucou|bonsoir|merci|thanks|thank you|ok|d accord|super|cool|top|parfait|bien|oui|non|yes|no)\b[\s!.,]*$/,
  /^[\d\s+\-*/^().,=%x×÷]+\??$/,
  /\b(traduis|traduire|translate|traduction)\b/,
  /\b(ecris|ecrire|redige|rediger|write|genere|cree)[^.?!]{0,30}\b(poeme|poesie|histoire|conte|blague|chanson|lettre|email|e-mail|mail|message|haiku|story|poem|joke)\b/,
  /\b(corrige|reformule|resume|ameliore|traduis|rewrite|summarize|proofread)\b[^.?!]{0,30}\b(ce texte|ce message|ce paragraphe|ceci|this text|the following)\b/,
  /\b(ecris|ecrire|code|coder|implemente|refactor|debug|corrige)[^.?!]{0,40}\b(fonction|script|classe|code|programme|requete sql|regex|composant|function|class|query)\b/,
];

const YEAR = /\b(19|20)\d{2}\b/g;

export function decideSearch(message: string, opts: { now?: Date; previousUsedSearch?: boolean } = {}): SearchDecision {
  const text = fold(message).replace(/['’]/g, " ").replace(/\s+/g, " ").trim();
  const now = opts.now ?? new Date();

  if (EXPLICIT.some((r) => r.test(text))) {
    const deep = DEEP.some((r) => r.test(text));
    return {
      search: true,
      mode: deep ? "deep" : "explicit",
      reason: "Recherche demandée explicitement.",
      timeSensitive: RECENCY.some((r) => r.test(text)),
      freshness: RECENCY.some((r) => r.test(text)) ? "year" : undefined,
    };
  }
  // Code collé, texte long fourni à transformer : la réponse dépend du contenu donné, pas du Web.
  if (/```/.test(message) || (message.length > 1500 && !/\?\s*$/.test(message.trim()))) {
    return { search: false, reason: "Le contenu nécessaire est fourni dans le message." };
  }
  if (NO_SEARCH.some((r) => r.test(text))) return { search: false, reason: "Question générale à laquelle le modèle peut répondre seul." };

  const recency = RECENCY.filter((r) => r.test(text)).length;
  const volatile = VOLATILE.filter((r) => r.test(text)).length;
  const currentYear = now.getFullYear();
  const recentYear = [...text.matchAll(YEAR)].some((m) => Number(m[0]) >= currentYear - 1);
  const deep = DEEP.some((r) => r.test(text));

  const timeSensitive = recency > 0 || recentYear;
  let score = recency * 2 + volatile * 2 + (recentYear ? 2 : 0);
  if (deep && (volatile || recency)) score += 1;
  // Suite courte d'une réponse déjà documentée (« et pour la version 15 ? ») : on reste sur le Web.
  if (opts.previousUsedSearch && text.length < 120 && /\?$|^(et|and|ou|aussi|meme|what about|how about)\b/.test(text)) score += 2;

  if (score >= 2) {
    const reason = recency || recentYear
      ? "Information récente ou datée : vérification sur le Web."
      : volatile
        ? "Information susceptible d'évoluer (prix, versions, documentation…) : vérification sur le Web."
        : "Suite d'une question documentée.";
    return {
      search: true,
      mode: deep ? "deep" : "auto",
      reason,
      timeSensitive,
      freshness: /\b(aujourd ?hui|hier|today|yesterday|cette semaine|this week|en ce moment|right now|breaking)\b/.test(text) ? "week" : undefined,
    };
  }
  return { search: false, reason: "Aucune information externe nécessaire." };
}
