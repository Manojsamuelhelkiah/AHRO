// Bundles the TS test files with esbuild and runs them with node's test runner.
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { existsSync, globSync, rmSync } from "node:fs";
import { builtinModules } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const dir = path.dirname(fileURLToPath(import.meta.url));
const requestedTestFile = process.env.TEST_FILE?.trim();
const entryPoints = [
  ...globSync("src/**/*.test.ts", { cwd: dir }),
  ...globSync("src/**/*.test.tsx", { cwd: dir }),
].filter((file) => !requestedTestFile || file === requestedTestFile)
  .map((f) => path.join(dir, f));
const integratedEntryPoints = [
  "src/components/client-workspace-navigation.integration.test.tsx",
  "src/pages/agents/registration-form.integration.test.tsx",
  "src/pages/settings-access-governance.integration.test.tsx",
  "src/pages/settings-context-retention.integration.test.tsx",
  "src/pages/settings-context-manager.integration.test.tsx",
  "src/pages/email-intake/turnaround.integration.test.tsx",
  "src/pages/settings-offboarding.integration.test.tsx",
  "src/pages/cases/detail/progress.integration.test.tsx",
].map((file) => path.join(dir, file));
const standardEntryPoints = entryPoints.filter(
  (entryPoint) => !integratedEntryPoints.includes(entryPoint),
);

if (entryPoints.length === 0) {
  console.error("No test files found");
  process.exit(1);
}

rmSync(path.join(dir, "dist-test"), { recursive: true, force: true });

const commonBuildOptions = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outExtension: { ".js": ".mjs" },
  jsx: "automatic",
  // react-dom/server (cjs) does require("util") etc.; when bundled to esm the
  // externalized require needs a real implementation.
  banner: {
    js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
  },
};

const organizationMembersTestStubs = {
  name: "organization-members-test-stubs",
  setup(build) {
    const membersComponentSuffix = path.join(
      "src",
      "pages",
      "settings-organization-members.tsx",
    );
    const isMembersComponent = (importer) =>
      importer.endsWith(membersComponentSuffix);

    build.onResolve(
      { filter: /^@workspace\/api-client-react$/ },
      (args) => {
        if (!isMembersComponent(args.importer)) return;
        return {
          path: path.join(
            dir,
            "src/pages/test-support/organization-members-api-stub.ts",
          ),
        };
      },
    );
    build.onResolve({ filter: /^@\// }, (args) => {
      if (
        isMembersComponent(args.importer) &&
        args.path === "@/hooks/use-organization-role"
      ) {
        return {
          path: path.join(
            dir,
            "src/pages/test-support/organization-members-role-stub.ts",
          ),
        };
      }

      const basePath = path.join(dir, "src", args.path.slice(2));
      const resolvedPath = [
        basePath,
        `${basePath}.ts`,
        `${basePath}.tsx`,
        `${basePath}.js`,
        `${basePath}.jsx`,
      ].find((candidate) => existsSync(candidate));
      return { path: resolvedPath ?? basePath };
    });
  },
};

if (standardEntryPoints.length > 0) {
  await build({
    ...commonBuildOptions,
    entryPoints: standardEntryPoints,
    outdir: path.join(dir, "dist-test"),
    external: ["node:*", ...builtinModules],
    plugins: [organizationMembersTestStubs],
  });
}

const integrationEntryPoints = integratedEntryPoints.filter(
  (entryPoint) => entryPoints.includes(entryPoint),
);
if (integrationEntryPoints.length > 0) {
  await build({
    ...commonBuildOptions,
    entryPoints: integrationEntryPoints,
    define: { "import.meta.env.BASE_URL": '"/"' },
    outdir: path.join(dir, "dist-test/integration"),
    external: [
      "node:*",
      ...builtinModules,
      "happy-dom",
      "react",
      "react-dom",
      "react-dom/*",
      "@tanstack/react-query",
    ],
    plugins: [
      {
        name: "clerk-integration-stubs",
        setup(build) {
          build.onResolve({ filter: /^@clerk\/react$/ }, () => ({
            path: "clerk-test-stub",
            namespace: "clerk-test",
          }));
          build.onLoad(
            {
              filter: /^clerk-test-stub$/,
              namespace: "clerk-test",
            },
            () => ({
              loader: "js",
              contents:
                [
                  'import React, { createContext, useContext } from "react";',
                  "const UserContext = createContext({ user: null, userId: null });",
                  "export function ClerkProvider({ children, user, userId, sessionId }) {",
                  "  return React.createElement(UserContext.Provider, { value: { user, sessionId, userId: userId === undefined ? user?.id : userId } }, children);",
                  "}",
                  "export function useUser() { return { ...useContext(UserContext), isLoaded: true }; }",
                  "export function useAuth() { return useContext(UserContext); }",
                  "export function useClerk() { return { signOut: async () => {} }; }",
                ].join("\n"),
            }),
          );
          build.onResolve({ filter: /^@\// }, (args) => {
            const basePath = path.join(dir, "src", args.path.slice(2));
            const resolvedPath = [basePath, `${basePath}.ts`, `${basePath}.tsx`].find(
              (candidate) => existsSync(candidate),
            );
            return { path: resolvedPath ?? basePath };
          });
        },
      },
    ],
  });
}

const result = spawnSync(
  process.execPath,
  [
    "--test",
    ...globSync("dist-test/**/*.test.mjs", { cwd: dir }).map((f) =>
      path.join(dir, f),
    ),
  ],
  { stdio: "inherit" },
);
process.exit(result.status ?? 1);
