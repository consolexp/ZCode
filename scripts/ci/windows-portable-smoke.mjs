import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, normalize, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import asar from "@electron/asar";
import { chromium } from "playwright-core";

const root = resolve(process.argv[2]);
const archive = join(root, "resources/app.asar");
const forbidden =
  /(^|[\\/])(?:\.zcode(?:-runtime)?|\.run-logs|\.git|workbuddy-cn\.enc|provider_config\.json|credentials\.json|tasks-index\.sqlite|sessions-index\.sqlite)([\\/]|$)/i;
for (const entry of asar.listPackage(archive)) {
  assert.ok(!forbidden.test(entry), `Account data in archive: ${entry}`);
}
async function checkFiles(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    assert.ok(!forbidden.test(entry.name), `Account data in distribution: ${entry.name}`);
    assert.ok(!entry.isSymbolicLink(), `Nonportable symlink: ${entry.name}`);
    if (entry.isDirectory()) await checkFiles(join(directory, entry.name));
  }
}
await checkFiles(root);
const metadata = JSON.parse(asar.extractFile(archive, normalize("out/metadata/build-meta.json")));
assert.equal(metadata.buildCommitId, process.env.GITHUB_SHA.slice(0, 8));
for (const resource of ["glm/zcode.cjs", "tools/ripgrep/rg.exe"]) {
  assert.ok((await stat(join(root, "resources", resource))).size > 0);
}
const stagedAgent = await readFile("packages/desktop/bundled-agents/win32-x64/glm/zcode.cjs");
assert.ok(stagedAgent.equals(await readFile(join(root, "resources/glm/zcode.cjs"))));

const profile = await mkdtemp(join(tmpdir(), "zcode-portable-smoke-"));
const env = {
  ...process.env,
  ZCODE_DISABLE_FIXED_REMOTE_DEBUGGING_PORT: "1",
  ZCODE_DATA_BASE_DIR: join(profile, "data"),
  ZCODE_DESKTOP_HOME_DIR: join(profile, "data"),
  ZCODE_DESKTOP_USER_DATA_DIR: join(profile, "electron"),
  ZCODE_DESKTOP_APPLICATION_NAME: "ZCode Portable Smoke",
};
for (const name of [
  "ELECTRON_RUN_AS_NODE",
  "ELECTRON_RENDERER_URL",
  "ZCODE_HOME",
  "NODE_OPTIONS",
]) {
  delete env[name];
}
await mkdir(join(profile, "data"), { recursive: true });
await mkdir(join(profile, "electron/session"), { recursive: true });
const child = spawn(join(root, "ZCode.exe"), ["--remote-debugging-port=0"], {
  cwd: root,
  env,
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
child.stdout.on("data", (data) => (output += data));
child.stderr.on("data", (data) => (output += data));
child.on("error", (error) => (output += error.message));
let browser;
try {
  let endpoint;
  for (let i = 0; i < 120; i++) {
    endpoint = output.match(
      /DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[^\s]+)/,
    )?.[1];
    if (endpoint) break;
    assert.equal(child.exitCode, null, "Packaged application exited before CDP was ready");
    await delay(500);
  }
  assert.ok(endpoint, "Missing packaged browser debugging endpoint");
  browser = await chromium.connectOverCDP(endpoint);
  let page;
  for (let i = 0; i < 60; i++) {
    page = browser
      .contexts()[0]
      .pages()
      .find((candidate) => candidate.url().includes("/index.html"));
    if (page) break;
    await delay(500);
  }
  assert.ok(page, "Packaged renderer window missing");
  page.setDefaultTimeout(30000);
  await page.getByTestId("login-use-api-key-button").click();
  await page.getByTestId("login-api-key-skip-button").click();
  await page.getByTestId("task-settings-button").click();
  await page.getByTestId("settings-section-nav-modelProvider").click();
  await page.getByTestId("model-provider-add-provider-button").click();
  await page.getByTestId("model-provider-template-item-workbuddy-cn").click();
  const panel = page.getByTestId("workbuddy-panel");
  await panel.waitFor();
  assert.match(await panel.innerText(), /尚未登录|Not signed in/);
  assert.equal(
    await panel.getByTestId("workbuddy-model-fallback").getAttribute("aria-checked"),
    "false",
  );
  for (let i = 0; i < 120 && !output.includes("zcode-session.readWorkspacePresentation OK"); i++) {
    assert.equal(child.exitCode, null, "Packaged application exited during Agent startup");
    await delay(500);
  }
  assert.ok(
    output.includes("zcode-session.readWorkspacePresentation OK"),
    "Bundled Agent did not finish workspace startup",
  );
  console.log(
    "Portable ZIP verified: current commit, clean account, WorkBuddy panel, embedded Agent ready",
  );
} finally {
  if (browser) {
    try {
      const session = await browser.newBrowserCDPSession();
      await session.send("Browser.close");
    } catch {
      /* The app may have already exited. */
    }
    await browser.close().catch(() => {});
  }
  if (child.exitCode === null) child.kill();
  await writeFile(join(profile, "startup.log"), output);
}
