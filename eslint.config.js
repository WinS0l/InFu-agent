// 审计修复（10）：根级 ESLint flat config——宽松基线：只拦截明确错误
// （未使用变量/可疑表达式/未定义引用），不强制代码风格（存量代码零噪音目标）。
// 未开 type-checked 规则（避免 require 完整类型检查拖慢 CI 与存量报错刷屏）。
const js = require("@eslint/js");
const tseslint = require("typescript-eslint");
const globals = require("globals");
const reactHooks = require("eslint-plugin-react-hooks");

module.exports = tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/target/**",
      "**/.infu-worktrees/**",
      "**/*.config.js",
      "**/scripts/**",
      "packages/desktop/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      // 存量代码惯用 any，不强制收敛（保守）
      "@typescript-eslint/no-explicit-any": "off",
      // 存量未使用变量/const 噪音量大，降 warn 不阻塞（增量治理）
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "no-unused-vars": "off",
      "prefer-const": "warn",
      "no-useless-assignment": "off",
      // 正则惯用 `\/` 转义；ANSI 转义序列（\x1b）裁剪是正常需求；空 catch 是
      // 审计防御惯用（吞无关异常）；rethrow 加 cause 非存量风格——全部不拦截
      "no-useless-escape": "off",
      "no-control-regex": "off",
      "no-empty": "off",
      "preserve-caught-error": "off",
      // 控制台在 CLI 中是正常输出通道
      "no-console": "off",
      // 显式布尔表达式是审计目标的防御性写法（如 isPathInside 全通道收口）
      "@typescript-eslint/no-unnecessary-condition": "off",
      "react-hooks/exhaustive-deps": "warn",
      "react-hooks/rules-of-hooks": "error",
    },
  },
  {
    files: ["**/*.{js,mjs,cjs}"],
    languageOptions: { globals: { ...globals.node } },
  },
);