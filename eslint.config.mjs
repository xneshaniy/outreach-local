import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

const eslintConfig = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    ignores: [
      ".next/**",
      "node_modules/**",
      "coverage/**",
      "prisma/migrations/**",
      "next-env.d.ts",
      "dist/**",
      "deploy/**",
    ],
  },
  {
    rules: {
      // Security-sensitive code deliberately uses raw SQL with parameter binding.
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },
  {
    // Deployment and maintenance scripts are plain CommonJS programs that
    // run on the server or in a terminal - not part of the Next.js app.
    files: ["scripts/**/*.{js,cjs}", "scripts/templates/**/*.{js,cjs}", "start.js"],
    languageOptions: {
      sourceType: "commonjs",
      globals: {
        __dirname: "readonly",
        console: "readonly",
        process: "readonly",
        require: "readonly",
        module: "writable",
        setTimeout: "readonly",
        Buffer: "readonly",
        URL: "readonly",
      },
    },
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
];

export default eslintConfig;
