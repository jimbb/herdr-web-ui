import { afterEach, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import installCavemanIntegration, { CAVEMAN_INTEGRATION_OWNERSHIP_BANNER } from "./install-caveman-integration.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function agentDir(): string {
  const root = mkdtempSync(join(tmpdir(), "herdr-caveman-installer-"));
  roots.push(root);
  return root;
}

it("bundles a standalone Node module that Caveman Code can load, beside its other extensions", async () => {
  const root = agentDir();
  mkdirSync(join(root, "extensions"));
  writeFileSync(join(root, "extensions", "mine.ts"), "the user's own");
  const { path } = await installCavemanIntegration({ agentDir: root });
  const output = readFileSync(path, "utf8");

  expect(path).toBe(join(root, "extensions", "herdr-web-ui.js"));
  expect(output.split("\n")[0]).toBe(CAVEMAN_INTEGRATION_OWNERSHIP_BANNER);
  expect(output).toContain("pane.report_agent");
  expect(output).not.toMatch(/from ["']\.\.\/(?:server|shared)\//);
  const loaded = await import(path) as { default: unknown };
  expect(typeof loaded.default).toBe("function");
  expect(readFileSync(join(root, "extensions", "mine.ts"), "utf8")).toBe("the user's own");

  expect(await installCavemanIntegration({ agentDir: root, remove: true })).toEqual({ action: "removed", path });
  expect(existsSync(path)).toBe(false);
});
