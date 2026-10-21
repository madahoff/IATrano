import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Application entièrement authentifiée et dynamique : on n'utilise pas Cache Components
  // (pas de shell statique utile, et <Activity> garderait montés les flux de chat).
  cacheComponents: false,
  partialPrefetching: false,
  output: "standalone",
  poweredByHeader: false,
  serverExternalPackages: ["@prisma/client", ".prisma/client"],
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
