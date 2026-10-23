import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Application entièrement authentifiée et dynamique : on n'utilise pas Cache Components
  // (pas de shell statique utile, et <Activity> garderait montés les flux de chat).
  cacheComponents: false,
  partialPrefetching: false,
  output: "standalone",
  poweredByHeader: false,
  // tesseract.js (OCR) lance un worker Node dont le script et le WebAssembly sont chargés par chemin à l'exécution :
  // paquet externe (non empaqueté) et fichiers ajoutés explicitement à la sortie standalone.
  serverExternalPackages: ["@prisma/client", ".prisma/client", "tesseract.js"],
  outputFileTracingIncludes: {
    "/*": [
      "./node_modules/.pnpm/tesseract.js@*/node_modules/**/*",
      "./node_modules/.pnpm/tesseract.js-core@*/node_modules/tesseract.js-core/*.{js,wasm}",
    ],
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'" },
        ],
      },
    ];
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
