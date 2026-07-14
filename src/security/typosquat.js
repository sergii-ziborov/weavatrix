// Typosquat / name-confusion detection: is a package name a near-miss of a popular one (a classic
// supply-chain lure — crossenv↔cross-env, lodahs↔lodash)? Damerau-Levenshtein (handles transposition)
// against a bundled top-package list. Deliberately LOW-FP: many legit packages sit distance-1 from a
// popular one, so the caller GATES this — transitive deps only surface when a second malware signal
// co-fires (scanMalware), direct deps surface quietly at info level. DEPS_SECURITY_PLAN P6.

// Popular + historically-typosquatted npm names. Not exhaustive — the high-value lure targets.
export const TOP_PACKAGES = new Set([
  "react", "react-dom", "lodash", "express", "axios", "chalk", "commander", "debug", "moment", "dayjs",
  "webpack", "babel", "eslint", "prettier", "typescript", "jest", "mocha", "chai", "vue", "angular",
  "next", "nuxt", "svelte", "vite", "rollup", "esbuild", "dotenv", "cors", "body-parser", "mongoose",
  "mongodb", "mysql", "mysql2", "pg", "redis", "ioredis", "sequelize", "knex", "prisma", "socket.io",
  "ws", "node-fetch", "got", "request", "superagent", "cross-env", "cross-spawn", "rimraf", "glob",
  "fs-extra", "chokidar", "nodemon", "concurrently", "husky", "lint-staged", "uuid", "nanoid", "bcrypt",
  "bcryptjs", "jsonwebtoken", "passport", "joi", "yup", "zod", "ajv", "classnames", "styled-components",
  "tailwindcss", "postcss", "autoprefixer", "sass", "less", "react-router", "react-router-dom", "redux",
  "react-redux", "@reduxjs/toolkit", "mobx", "recoil", "zustand", "formik", "react-hook-form", "immer",
  "rxjs", "date-fns", "ramda", "underscore", "immutable", "yargs", "inquirer", "ora", "boxen", "chalk",
  "colors", "winston", "pino", "morgan", "helmet", "compression", "cookie-parser", "express-session",
  "multer", "sharp", "jimp", "puppeteer", "playwright", "cypress", "supertest", "sinon", "nock",
  "ts-node", "tslib", "core-js", "regenerator-runtime", "@babel/core", "babel-loader", "css-loader",
  "style-loader", "html-webpack-plugin", "terser", "browserify", "gulp", "grunt", "electron", "three",
  "d3", "chart.js", "echarts", "leaflet", "mapbox-gl", "graphql", "apollo-server", "@apollo/client",
  "protobufjs", "grpc", "kafkajs", "amqplib", "bull", "node-cron", "cheerio", "jsdom", "marked",
  "markdown-it", "highlight.js", "prismjs", "qs", "querystring", "form-data", "semver", "minimist",
]);

// Legit close pairs to NOT flag (real distinct packages that happen to sit distance-1/2 apart).
const KNOWN_LEGIT = new Set([
  "cross-spawn", "react-dom", "react-router", "bcryptjs", "mysql2", "colors", "underscore", "querystring",
  "markdown-it", "babel-loader", "css-loader", "style-loader",
]);

const norm = (name) => String(name || "").toLowerCase().replace(/^@[^/]+\//, ""); // drop scope for the compare

// Damerau-Levenshtein (optimal string alignment) — includes adjacent transposition.
export function damerau(a, b) {
  a = String(a); b = String(b);
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  const d = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) d[i][0] = i;
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[m][n];
}

// → { nearest, distance } if `name` looks like a typosquat of a popular package, else null.
// Threshold: distance 1 always; distance 2 only for names ≥8 chars (short names collide too easily).
// Skip: exact popular names, known-legit pairs, names <4 chars.
export function classifyTyposquat(name) {
  const raw = String(name || "");
  const n = norm(raw);
  if (n.length < 4 || TOP_PACKAGES.has(raw) || TOP_PACKAGES.has(n) || KNOWN_LEGIT.has(raw) || KNOWN_LEGIT.has(n)) return null;
  let best = null;
  for (const top of TOP_PACKAGES) {
    const t = norm(top);
    if (t === n) return null; // scope-only difference of a popular name → not a squat
    const dist = damerau(n, t);
    if (dist === 0) return null;
    const limit = t.length >= 8 ? 2 : 1;
    if (dist <= limit && (!best || dist < best.distance)) best = { nearest: top, distance: dist };
  }
  return best;
}
