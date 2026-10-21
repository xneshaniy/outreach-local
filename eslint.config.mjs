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
    // Deployment templates are copied verbatim into the deploy bundle and run
    // as plain CommonJS scripts on the server (not part of the Next.js app).
    files: ["scripts/templates/**/*.{js,cjs}"],
    languageOptions: {
      sourceType: "commonjs",
      globals: {
        __dirname: "readonly",
        console: "readonly",
        process: "readonly",
        require: "readonly",
        module: "writable",
        setTimeout: "readonly",
      },
    },
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
];

export default eslintConfig;
