// Synthetic cached catalog; no WorkBuddy credentials or upstream model requests.
// Run after building desktop: node packages/desktop/test/e2e/workbuddy/manual-review/pending/model-details-smoke.mjs
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { _electron } from "playwright-core";

const profile = await mkdtemp(resolve(".run-logs/workbuddy-model-details-"));
const data = join(profile, "data");
const configDir = join(data, ".zcode", "v2");
await mkdir(configDir, { recursive: true });
const models = [
  {
    id: "hy3",
    name: "E2E Hy3",
    credits: "x1.00",
    promotions: [
      {
        id: "E2E_ACTIVE_FREE",
        kind: "discount",
        badge: { label: "限时免费", labelEn: "Free trial" },
        discount: { discountedCredits: "0x", factor: 0, displayMode: "replace" },
        hover: { textZh: "E2E_OFFICIAL_PROMOTION_TEXT", textEn: "E2E_OFFICIAL_PROMOTION_ENGLISH" },
      },
      {
        id: "E2E_EXPIRED",
        priority: 999,
        badge: { label: "E2E_EXPIRED_BADGE" },
        schedule: { validUntil: "2000-01-01T00:00:00Z" },
      },
    ],
    descriptionZh: "E2E_FIXED_MODEL_DESCRIPTION",
    descriptionEn: "E2E_FIXED_MODEL_ENGLISH",
    busyLevel: "idle",
    contextWindow: 192000,
    reasoning: { defaultEffort: "high", supportedEfforts: [] },
  },
  {
    id: "deepseek-v4.1-flash",
    name: "E2E DeepSeek-V4.1-Flash-Extended-Context",
    credits: "1.00x credits",
    promotions: [
      {
        id: "E2E_DISCOUNT",
        kind: "discount",
        badge: { label: "夜间折扣" },
        discount: { discountedCredits: "0.5x", factor: 0.5, displayMode: "strikethrough" },
      },
    ],
    tier: {
      id: "E2E_TIER",
      tier: "standard",
      badge: { label: "订阅优先" },
      hover: { textZh: "E2E_TIER_TEXT", action: { type: "upgrade", labelZh: "去升级" } },
    },
    descriptionZh: "E2E_ADJUSTABLE_MODEL_DESCRIPTION",
    descriptionEn: "E2E_ADJUSTABLE_MODEL_ENGLISH",
    busyLevel: "congested",
    contextWindow: 300000,
    contextWindows: [300000, 600000, 1000000],
    supportsImages: true,
    maxInputTokens: 1000000,
    maxOutputTokens: 128000,
    reasoning: { defaultEffort: "high", supportedEfforts: ["low", "high", "max"] },
  },
  {
    id: "deepseek-v4.1-pro",
    name: "E2E DeepSeek-V4.1-Pro",
    credits: "x0.11 credits",
    reasoning: { defaultEffort: "high", supportedEfforts: [] },
  },
];
await writeFile(
  join(configDir, "provider_config.json"),
  JSON.stringify({
    schemaVersion: 1,
    config: {
      providerConfigRules: {
        providerRules: [
          {
            providerId: "e2e-workbuddy",
            providerName: "E2E WorkBuddy",
            enabled: true,
            config: {
              integration: "workbuddy-cn",
              group: "standard-personal",
              access: { type: "api-key", apiKey: "E2E_MODEL_DETAILS_ONLY_12345678901234567890" },
              api: { type: "openai-responses", baseUrl: "http://127.0.0.1:1/v1" },
              personalModelIds: models.map((m) => m.id),
              modelOrder: models.map((m) => m.id),
            },
          },
        ],
      },
      modelConfigRules: {
        providerModelRules: models.map((model) => ({
          providerId: "e2e-workbuddy",
          modelId: model.id,
          config: {
            enabled: true,
            optionSpecs: {
              reasoningLevel: {
                values: model.reasoning.supportedEfforts.length
                  ? model.reasoning.supportedEfforts
                  : ["high"],
                map: '{ "reasoning": { "effort": reasoningLevel } }',
              },
            },
          },
        })),
        manualProviderModelRules: [],
      },
      defaultModelSelection: { providerId: "e2e-workbuddy", modelId: "hy3" },
    },
  }),
);
// StateStore supports legacy plaintext and encrypts on its next write; all values here are synthetic.
await writeFile(
  join(configDir, "workbuddy-cn.enc"),
  JSON.stringify({
    version: 1,
    port: 0,
    accounts: {
      "e2e-workbuddy": {
        generation: "E2E_GENERATION",
        secret: "E2E_MODEL_DETAILS_ONLY_12345678901234567890",
        models,
        modelSource: "snapshot",
        modelDetailsUpdatedAt: Date.now(),
        usage: {},
      },
    },
  }),
);
const env = {
  ...process.env,
  ZCODE_ENV: "production",
  ZCODE_DISABLE_FIXED_REMOTE_DEBUGGING_PORT: "1",
  ZCODE_DATA_BASE_DIR: data,
  ZCODE_DESKTOP_HOME_DIR: data,
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
const page = await app.firstWindow();
try {
  page.setDefaultTimeout(20_000);
  await page.getByTestId("login-use-api-key-button").click();
  await page.getByTestId("login-api-key-skip-button").click();
  const trigger = page.locator('[data-testid="chat-model-select-trigger"]').first();
  await trigger.click();
  const fixed = page.getByTestId("workbuddy-model-info-hy3");
  await fixed.waitFor();
  const menu = page.locator('[data-slot="dropdown-menu-content"]').filter({ has: fixed });
  const verifyModelNames = async (label) => {
    // 菜单打开有缩放动画，先等待布局稳定再测量最终宽度。
    await menu.hover({ trial: true });
    const menuBox = await menu.boundingBox();
    const width = await page.evaluate(() => window.innerWidth);
    assert.ok(menuBox && menuBox.x >= 0 && menuBox.x + menuBox.width <= width + 1);
    if (width > 600) assert.ok(menuBox.width >= 440, "desktop model menu must be wider");
    for (const model of models) {
      const name = menu.locator("[title]").filter({ hasText: model.name });
      assert.equal(await name.innerText(), model.name);
      assert.ok(
        await name.evaluate((element) => {
          const style = getComputedStyle(element);
          return (
            style.textOverflow !== "ellipsis" &&
            element.scrollWidth <= element.clientWidth + 1 &&
            element.scrollHeight <= element.clientHeight + 1
          );
        }),
        `${label}: full model name must be visible: ${model.name}`,
      );
    }
    assert.ok(
      await menu.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
      "model row must not overflow menu",
    );
    assert.doesNotMatch(await menu.innerText(), /credits/i);
    assert.match(await menu.innerText(), /x0\.11/);
    await page.screenshot({ path: join(profile, `model-names-${label}.png`) });
  };
  await verifyModelNames("desktop-light");
  assert.equal(await page.getByTestId("composer-thought-slider").count(), 0);
  const selected = page.locator('[data-model-option-selected="true"]');
  const originalSelection = await selected.getAttribute("data-testid");
  await fixed.click();
  const fixedDetails = page.getByTestId("workbuddy-model-details-hy3");
  await fixedDetails.waitFor();
  assert.match(await fixedDetails.innerText(), /E2E_FIXED_MODEL_DESCRIPTION/);
  assert.match(await fixedDetails.innerText(), /0.00x/);
  assert.match(await fixedDetails.innerText(), /E2E_OFFICIAL_PROMOTION_TEXT/);
  assert.equal(await page.getByText("E2E_EXPIRED_BADGE").count(), 0);
  assert.match(await fixedDetails.innerText(), /高 · 固定/);
  assert.equal(await selected.getAttribute("data-testid"), originalSelection);
  await page.screenshot({ path: join(profile, "fixed-light.png") });
  await page.mouse.move(300, 100);
  await fixed.press("Escape");
  await fixedDetails.waitFor({ state: "hidden" });
  const adjustable = page
    .locator('[data-testid^="chat-model-select-item"]')
    .filter({ hasText: models[1].name });
  await adjustable.click();
  const slider = page.getByTestId("composer-thought-slider");
  await slider.waitFor();
  assert.equal(await slider.getAttribute("data-levels"), '["low","high","max"]');
  await slider.press("End");
  assert.equal(await slider.getAttribute("aria-valuetext"), "最高");
  // 分别验证点击详情和新一轮悬停，避免旧详情的焦点恢复干扰下一项。
  await slider.press("Escape");
  await menu.waitFor({ state: "hidden" });
  await trigger.click();
  const info = page.getByTestId("workbuddy-model-info-deepseek-v4.1-flash");
  await info.hover();
  const details = page.getByTestId("workbuddy-model-details-deepseek-v4.1-flash");
  await details.waitFor();
  assert.match(await details.innerText(), /E2E_ADJUSTABLE_MODEL_DESCRIPTION/);
  assert.match(await details.innerText(), /拥堵/);
  assert.match(await details.innerText(), /E2E_TIER_TEXT/);
  assert.equal(await details.locator("del").innerText(), "1.00x");
  assert.match(await details.innerText(), /0.50x/);
  assert.match(await details.innerText(), /30万 \/ 60万 \/ 100万/);
  await page.screenshot({ path: join(profile, "adjustable-light.png") });
  await page.evaluate(() => {
    document.documentElement.classList.remove("theme-zai-light");
    document.documentElement.classList.add("dark", "theme-zai-dark");
  });
  await page.screenshot({ path: join(profile, "adjustable-dark.png") });
  await page.mouse.move(300, 100);
  await info.press("Escape");
  await details.waitFor({ state: "hidden" });
  await verifyModelNames("desktop-dark");
  await page.setViewportSize({ width: 390, height: 844 });
  await verifyModelNames("narrow-dark");
  await info.click();
  await details.waitFor();
  const box = await details.boundingBox();
  await page.screenshot({ path: join(profile, "adjustable-narrow.png") });
  console.log(
    JSON.stringify({ profile, box, width: await page.evaluate(() => window.innerWidth) }),
  );
  assert.ok(
    box && box.x >= 0 && box.x + box.width <= 390,
    "narrow model details must stay in viewport",
  );
  await page.screenshot({ path: join(profile, "adjustable-narrow.png") });
  await writeFile(
    join(profile, "result.json"),
    JSON.stringify(
      {
        status: "passed",
        synthetic: true,
        providerRequestPolicy: "none",
        cases: [
          "fixed-effort-hidden",
          "details-click-no-selection",
          "multi-effort-slider",
          "hover-details",
          "light-dark",
          "390px",
          "full-model-names-desktop-and-narrow",
          "compact-credit-multipliers",
        ],
      },
      null,
      2,
    ),
  );
  console.log(`WorkBuddy model details smoke passed: ${profile}`);
} catch (error) {
  await page.screenshot({ path: join(profile, "failure.png") });
  console.log(
    JSON.stringify({
      profile,
      details: await page.locator("[data-slot=hover-card-content]").evaluateAll((elements) =>
        elements.map((e) => ({
          text: e.textContent?.slice(0, 100),
          rect: e.getBoundingClientRect().toJSON(),
          style: e.getAttribute("style"),
        })),
      ),
    }),
  );
  throw error;
} finally {
  await app.close();
}
