// Refus des données sensibles dans la mémoire persistante : mots de passe, secrets d'authentification,
// clés d'API, jetons, numéros de carte ou IBAN. Appliqué à toute écriture (manuelle ou automatique).

// Mot-clé immédiatement suivi d'une valeur : « mot de passe : x », « token=x », « mon mdp est x ».
const SECRET_ASSIGNMENT =
  /\b(mot de passe|password|passwd|passphrase|mdp|code (?:d'accès|secret|pin)|pin|secret|token|jeton|api[ _-]?key|cl[ée] (?:d'api|api|secrète|privée|ssh)|private key|bearer|otp|cvv|cvc)\s*(?:[:=]|est\b|is\b|vaut\b)\s*\S+/i;

const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(sk|pk|rk)[-_](live|test|proj)?[-_]?[A-Za-z0-9]{16,}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/,
  /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){3,7}\b/, // IBAN
];

function luhn(digits: string) {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

/** Chaîne longue et aléatoire (clé, jeton) : mélange de casse et de chiffres, sans espace. */
function looksRandom(word: string) {
  if (word.length < 24 || /^https?:/i.test(word)) return false;
  const classes = [/[a-z]/, /[A-Z]/, /\d/].filter((r) => r.test(word)).length;
  return classes === 3 && !/[aeiou]{2}/i.test(word.slice(0, 12));
}

/** Mémoire enregistrée automatiquement : aucune mention de secret, même sans valeur (« a donné son mot de passe »). */
const SECRET_MENTION = /\b(mot de passe|mots de passe|password|passwd|mdp|secret|token|jeton|api[ _-]?key|cl[ée] (?:d'api|api|secrète|privée|ssh)|code (?:pin|d'accès|secret)|cvv|iban|carte bancaire)\b/i;

export function autoMemoryRejected(text: string): string | null {
  return sensitiveReason(text) ?? (SECRET_MENTION.test(text) ? "Les informations liées à des secrets ne sont pas mémorisées automatiquement." : null);
}

/** Renvoie la raison du refus, ou null si le texte peut être mémorisé. */
export function sensitiveReason(text: string): string | null {
  if (SECRET_ASSIGNMENT.test(text)) return "Les mots de passe et secrets ne sont jamais mémorisés.";
  if (SECRET_PATTERNS.some((r) => r.test(text))) return "Ce texte ressemble à une clé, un jeton ou un identifiant bancaire : il n'est pas mémorisé.";
  for (const m of text.match(/\b(?:\d[ -]?){13,19}\b/g) ?? []) {
    if (luhn(m.replace(/\D/g, ""))) return "Les numéros de carte bancaire ne sont pas mémorisés.";
  }
  if (text.split(/\s+/).some(looksRandom)) return "Ce texte contient une chaîne qui ressemble à un secret : il n'est pas mémorisé.";
  return null;
}

// Informations personnelles sensibles (santé, convictions, orientation, origine, situation judiciaire ou financière) :
// jamais mémorisées automatiquement. L'utilisateur peut les retenir sur demande explicite ou les saisir lui-même.
// Racines suivies de lettres quelconques (« diabète », « diabétique ») ; frontières Unicode (\b ignore les accents).
const term = (alternatives: string) => new RegExp(`(?<![\\p{L}\\d])(?:${alternatives})(?![\\p{L}\\d])`, "iu");
const SENSITIVE_PERSONAL = [
  term("malad(?:ie|e)s?|diab[èée]t\\p{L}*|cancers?|d[ée]pression|d[ée]prim[ée]e?|anxi[ée]t[ée]|handicap\\p{L}*|enceinte|grossesse|traitement m[ée]dical|m[ée]dicaments?|th[ée]rapie|psychiatr\\p{L}*|s[ée]ropositi\\p{L}*|vih|hiv|ant[ée]c[ée]dents m[ée]dicaux|diagnostiqu[ée]e? (?:avec|d\\p{L}*)|ma sant[ée]"),
  term("religion|musulmane?|chr[ée]tienne?|catholique|protestante?|juif|juive|bouddhiste|ath[ée]e|croyante?|je prie"),
  term("je vote|j'ai vot[ée]|parti politique|militante?|syndiqu[ée]e?|opinions? politiques?"),
  term("homosexuel\\p{L}*|h[ée]t[ée]rosexuel\\p{L}*|bisexuel\\p{L}*|gay|lesbienne|transgenre|orientation sexuelle|vie sexuelle"),
  term("origine ethnique|ethnie|casier judiciaire|condamn[ée]e?|incarc[ée]r\\p{L}*|mes dettes|surendett\\p{L}*|mon salaire|mes revenus|num[ée]ro de s[ée]curit[ée] sociale|passeport|carte d'identit[ée]"),
];

/** Raison du refus d'une mémorisation automatique d'information personnelle sensible, ou null. */
export function sensitivePersonalReason(text: string): string | null {
  return SENSITIVE_PERSONAL.some((r) => r.test(text))
    ? "Information personnelle sensible non mémorisée automatiquement : dites « retiens que… » ou ajoutez-la depuis la page Mémoire si vous le souhaitez."
    : null;
}
