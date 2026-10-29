// Run from the repository root after building desktop: node packages/desktop/test/e2e/workbuddy/manual-review/pending/settings-smoke.mjs
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { _electron } from "playwright-core";

const artifacts = resolve(".run-logs");
await mkdir(artifacts, { recursive: true });
const profile = await mkdtemp(join(artifacts, "workbuddy-e2e-"));
const env = {
  ...process.env,
  ZCODE_ENV: "production",
  ZCODE_DISABLE_FIXED_REMOTE_DEBUGGING_PORT: "1",
  ZCODE_DATA_BASE_DIR: join(profile, "data"),
  ZCODE_DESKTOP_HOME_DIR: join(profile, "data"),
  ZCODE_DESKTOP_USER_DATA_DIR: join(profile, "electron"),
};
delete env.ELECTRON_RUN_AS_NODE;
const executablePath = resolve(
  "node_modules/electron/dist",
  process.platform === "win32"
    ? "electron.exe"
    : process.platform === "darwin"
      ? "Electron.app/Contents/MacOS/Electron"
      : "electron",
);
const app = await _electron.launch({ executablePath, args: [resolve("packages/desktop")], env });
try {
  const page = await app.firstWindow();
  page.setDefaultTimeout(20_000);
  // 通过现有跳过入口配置渠道；本用例不发送模型请求或使用真实账号。
  await page.getByTestId("login-use-api-key-button").click();
  await page.getByTestId("login-api-key-skip-button").click();
  await page.getByTestId("task-settings-button").click();
  await page.getByTestId("settings-section-nav-modelProvider").click();

  const panel = page.getByTestId("workbuddy-panel");
  const create = async (name) => {
    await page.getByTestId("model-provider-add-provider-button").click();
    await page.getByTestId("model-provider-template-item-workbuddy-cn").click();
    await panel.waitFor();
    const id = await panel.getAttribute("data-provider-id");
    assert.ok(id);
    await panel.getByTestId("workbuddy-name").fill(name);
    await panel.getByRole("button", { name: "保存名称", exact: true }).click();
    await page.getByRole("button", { name, exact: true }).waitFor();
    assert.match(await panel.innerText(), /尚未登录/);
    return id;
  };
  const first = await create("E2E_WB_ONE");
  const fallback = panel.getByTestId("workbuddy-model-fallback");
  assert.equal(await fallback.getAttribute("aria-checked"), "false");
  await fallback.click();
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-testid="workbuddy-model-fallback"]')
        ?.getAttribute("aria-checked") === "true",
  );
  await panel.getByTestId("workbuddy-import-login").click();
  await panel.getByTestId("workbuddy-login-text").fill("E2E_INVALID_IMPORT");
  await panel.getByRole("button", { name: "验证并导入" }).click();
  await panel.getByRole("alert").waitFor();
  assert.match(await panel.innerText(), /尚未登录/);
  await panel.getByRole("button", { name: "关闭", exact: true }).click();
  const firstModel = panel.getByRole("checkbox").first();
  await firstModel.click();
  await page.waitForFunction(
    () =>
      document.querySelector('[data-testid="workbuddy-panel"] input[type="checkbox"]')?.checked ===
      false,
  );
  const second = await create("E2E_WB_TWO");
  assert.notEqual(first, second);
  assert.equal(await fallback.getAttribute("aria-checked"), "false");
  assert.equal(await panel.getByRole("checkbox").first().isChecked(), true);
  await page.getByRole("button", { name: "E2E_WB_ONE", exact: true }).click();
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-testid="workbuddy-model-fallback"]')
        ?.getAttribute("aria-checked") === "true",
  );
  assert.equal(await panel.getAttribute("data-provider-id"), first);
  assert.equal(await panel.getByRole("checkbox").first().isChecked(), false);
  await panel.getByTestId("workbuddy-sync").click();
  await panel.getByTestId("workbuddy-sync").waitFor({ state: "visible" });
  assert.equal(await panel.getByRole("checkbox").count(), 3);
  assert.equal(await panel.getByRole("checkbox").first().isChecked(), false);

  for (const theme of ["light", "dark"]) {
    await page.evaluate((value) => {
      const root = document.documentElement;
      root.classList.toggle("dark", value === "dark");
      root.classList.toggle("theme-zai-dark", value === "dark");
      root.classList.toggle("theme-zai-light", value === "light");
    }, theme);
    await page.screenshot({ path: join(profile, `settings-${theme}.png`) });
  }
  await page.setViewportSize({ width: 850, height: 720 });
  await page.screenshot({ path: join(profile, "settings-narrow.png") });
  assert.equal(await panel.getByTestId("workbuddy-login").isVisible(), true);
  await writeFile(
    join(profile, "result.json"),
    JSON.stringify(
      {
        status: "passed",
        providerRequestPolicy: "none",
        cases: [
          "create-two-channels",
          "rename",
          "switch-isolation",
          "model-toggle-persistence",
          "snapshot-sync",
          "theme-layout",
        ],
        realAccountVerified: false,
      },
      null,
      2,
    ),
  );
  console.log(`WorkBuddy desktop smoke passed: ${profile}`);
} finally {
  await app.close();
}
