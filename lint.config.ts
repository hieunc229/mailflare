import type { OxlintConfig } from "vite-plus/lint";

const lintConfig = {
  "plugins": [
    "eslint",
    "react",
    "nextjs",
    "typescript",
    "import",
    "jsx-a11y"
  ],
  "categories": {
    "correctness": "off"
  },
  "env": {
    "browser": true,
    "node": true
  },
  // These JS plugins preserve coverage missing from native Oxlint.
  "jsPlugins": [
    {
      "name": "nextjs-js",
      "specifier": "@next/eslint-plugin-next"
    },
    {
      "name": "react-js",
      "specifier": "eslint-plugin-react"
    },
    {
      "name": "react-hooks-js",
      "specifier": "eslint-plugin-react-hooks"
    },
    {
      "name": "typescript-eslint-js",
      "specifier": "@typescript-eslint/eslint-plugin"
    }
  ],
  "rules": {
    "react/display-name": "error",
    "react/jsx-key": "error",
    "react/jsx-no-comment-textnodes": "error",
    "react/jsx-no-duplicate-props": "error",
    "react/jsx-no-undef": "error",
    "react/no-children-prop": "error",
    "react/no-danger-with-children": "error",
    "react-js/no-deprecated": "error",
    "react/no-direct-mutation-state": "error",
    "react/no-find-dom-node": "error",
    "react/no-is-mounted": "error",
    "react/no-render-return-value": "error",
    "react/no-string-refs": "error",
    "react/no-unescaped-entities": "error",
    "react/require-render-return": "error",
    "react/rules-of-hooks": "error",
    "react/exhaustive-deps": "warn",
    "react/static-components": "error",
    "react/use-memo": "error",
    "react/preserve-manual-memoization": "error",
    "react/incompatible-library": "warn",
    "react/immutability": "error",
    "react/globals": "error",
    "react/refs": "error",
    "react/set-state-in-effect": "error",
    "react/error-boundaries": "error",
    "react/purity": "error",
    "react/set-state-in-render": "error",
    "react/unsupported-syntax": "warn",
    "react-hooks-js/config": "error",
    "react-hooks-js/gating": "error",
    "nextjs/google-font-display": "warn",
    "nextjs/google-font-preconnect": "warn",
    "nextjs/next-script-for-ga": "warn",
    "nextjs/no-async-client-component": "warn",
    "nextjs/no-before-interactive-script-outside-document": "warn",
    "nextjs/no-css-tags": "warn",
    "nextjs/no-head-element": "warn",
    "nextjs/no-html-link-for-pages": "error",
    "nextjs/no-img-element": "warn",
    "nextjs-js/no-location-assign-relative-destination": "warn",
    "nextjs/no-page-custom-font": "warn",
    "nextjs/no-styled-jsx-in-document": "warn",
    "nextjs/no-sync-scripts": "error",
    "nextjs/no-title-in-document-head": "warn",
    "nextjs/no-typos": "warn",
    "nextjs/no-unwanted-polyfillio": "warn",
    "nextjs/inline-script-id": "error",
    "nextjs/no-assign-module-variable": "error",
    "nextjs/no-document-import-in-page": "error",
    "nextjs/no-duplicate-head": "error",
    "nextjs/no-head-import-in-document": "error",
    "nextjs/no-script-component-in-head": "error",
    "import/no-anonymous-default-export": "warn",
    "jsx-a11y/alt-text": [
      "warn",
      {
        "elements": [
          "img"
        ],
        "img": [
          "Image"
        ]
      }
    ],
    "jsx-a11y/aria-props": "warn",
    "jsx-a11y/aria-proptypes": "warn",
    "jsx-a11y/aria-unsupported-elements": "warn",
    "jsx-a11y/role-has-required-aria-props": "warn",
    "jsx-a11y/role-supports-aria-props": "warn",
    "no-var": "error",
    "prefer-const": [
      "error",
      {
        "destructuring": "any",
        "ignoreReadBeforeAssign": false
      }
    ],
    "prefer-rest-params": "error",
    "prefer-spread": "error",
    "typescript/ban-ts-comment": "error",
    "no-array-constructor": "error",
    "typescript/no-duplicate-enum-values": "error",
    "typescript/no-empty-object-type": "error",
    "typescript/no-explicit-any": "error",
    "typescript/no-extra-non-null-assertion": "error",
    "typescript/no-misused-new": "error",
    "typescript/no-namespace": "error",
    "typescript/no-non-null-asserted-optional-chain": "error",
    "typescript/no-require-imports": "error",
    "typescript/no-this-alias": "error",
    "typescript/no-unnecessary-type-constraint": "error",
    "typescript/no-unsafe-declaration-merging": "error",
    "typescript/no-unsafe-function-type": "error",
    "no-unused-expressions": [
      "warn",
      {
        "allowShortCircuit": false,
        "allowTaggedTemplates": false,
        "allowTernary": false
      }
    ],
    "no-unused-vars": [
      "warn",
      {}
    ],
    "typescript/no-wrapper-object-types": "error",
    "typescript/prefer-as-const": "error",
    "typescript/prefer-namespace-keyword": "error",
    "typescript/triple-slash-reference": "error"
  },
  "ignorePatterns": [
    ".next/**",
    ".next-node/**",
    ".vinext/**",
    ".wrangler/**",
    "node_modules/**",
    "drizzle/**",
    "dist/**",
    "data/**",
    "deploy/**/node_modules/**",
    "cloudflare-env.d.ts",
    "next-env.d.ts"
  ],
  "overrides": [
    {
      "files": [
        "**/*.d.ts"
      ],
      "rules": {
        "no-unused-vars": "off",
        "typescript-eslint-js/no-unused-vars": "warn"
      }
    }
  ]
} satisfies OxlintConfig;

export default lintConfig;
