// Cache mémoire borné à durée de vie (résultats de recherche et pages extraites), propre au processus.
// Rien n'est écrit sur disque : aucune copie permanente des pages. Les entrées servies depuis le cache
// sont signalées comme telles (champ `cached` des sources) pour ne pas les présenter comme fraîches.

export class TtlCache<V> {
  private readonly map = new Map<string, { at: number; value: V }>();

  constructor(private readonly maxEntries: number) {}

  get(key: string, ttlMs: number): { value: V; at: number } | null {
    if (ttlMs <= 0) return null;
    const hit = this.map.get(key);
    if (!hit) return null;
    if (Date.now() - hit.at > ttlMs) {
      this.map.delete(key);
      return null;
    }
    // LRU : réinsertion en fin de file.
    this.map.delete(key);
    this.map.set(key, hit);
    return hit;
  }

  set(key: string, value: V) {
    this.map.delete(key);
    this.map.set(key, { at: Date.now(), value });
    while (this.map.size > this.maxEntries) this.map.delete(this.map.keys().next().value!);
  }

  clear() {
    this.map.clear();
  }
}
