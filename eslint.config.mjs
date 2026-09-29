import tseslint from "typescript-eslint";
export default tseslint.config(
  { ignores: ["dist/**", "**/.next/**", "node_modules/**", "**/next-env.d.ts"] },
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
);
