// Simule le contexte de requête de Next.js (cookies(), headers()) pour appeler les vrais handlers de routes.
type Cookie = { name: string; value: string };
const jar = new Map<string, Cookie>();
let requestHeaders = new Headers();

export const requestContext = {
  reset() {
    jar.clear();
    requestHeaders = new Headers();
  },
  setCookie(name: string, value: string) {
    jar.set(name, { name, value });
  },
  getCookie(name: string) {
    return jar.get(name)?.value;
  },
  setHeaders(h: Record<string, string>) {
    requestHeaders = new Headers(h);
  },
};

export const nextHeadersMock = {
  cookies: async () => ({
    get: (name: string) => jar.get(name),
    has: (name: string) => jar.has(name),
    set: (name: string, value: string) => {
      jar.set(name, { name, value });
    },
    delete: (name: string) => {
      jar.delete(name);
    },
  }),
  headers: async () => requestHeaders,
};
