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
];

export default eslintConfig;
