import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Almost every page reads the database behind a sign-in, so the app renders
  // dynamically at request time; Cache Components stays off until something
  // needs the static shell.
  cacheComponents: false,
  typedRoutes: true,
  // Next's own current docs live in node_modules/next/dist/docs; the generated
  // AGENTS.md pointer is off so no managed file churns in the tree.
  agentRules: false,
  // Playwright drives the dev server through 127.0.0.1.
  allowedDevOrigins: ["127.0.0.1"],
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
