import assert from "node:assert/strict";
import { chromium } from "playwright";
import { fixture } from "./fixture.mjs";

// Uses a temporary database and fake provider; never loads local credentials.
const app = await fixture();
const browser = await chromium.launch({ headless: true });
try {
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(app.origin);
    await page.locator(".model-button").click();
    await page.locator(".model-row").last().waitFor();
    assert.equal(await page.locator(".model-row").count(), 13);
    await page.getByRole("button", { name: /Qwen3.8 27B/ }).click();
    await page.reload();
    await page.waitForFunction(() => document.querySelector(".model-button")?.textContent.includes("Qwen3.8 27B"));
    await page.locator(".model-button").click();
    await page.getByLabel("Search models", { exact: true }).fill("GLM-5.3 (max)");
    assert.equal(await page.locator(".model-row").count(), 1);
    await page.locator(".model-row").click();
    await page.getByLabel("Message", { exact: true }).fill("Browser acceptance chat");
    await page.reload();
    await page.waitForFunction(() => document.querySelector("textarea")?.value === "Browser acceptance chat");
    await page.getByLabel("Send message", { exact: true }).click();
    await page.getByText("Fixture reply 👋", { exact: true }).waitFor();
    await page.getByLabel("Send message", { exact: true }).waitFor();
    if (viewport.width < 600) await page.getByLabel("Open history", { exact: true }).click();
    await page.getByLabel("Rename Browser acceptance chat", { exact: true }).click();
    await page.getByLabel("Conversation name", { exact: true }).fill("Verified conversation");
    await page.getByLabel("Save conversation name", { exact: true }).click();
    await page.getByRole("button", { name: "Verified conversation", exact: true }).waitFor();
    await page.reload();
    if (viewport.width < 600) await page.getByLabel("Open history", { exact: true }).click();
    await page.getByRole("button", { name: "Verified conversation", exact: true }).click();
    await page.getByText("Fixture reply 👋", { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    if (viewport.width < 600) await page.locator("aside.open").waitFor({ state: "hidden" });
    assert.deepEqual(errors, []);
    await page.screenshot({ path: `/tmp/openchat-verified-${viewport.width}.png`, fullPage: true, animations: "disabled" });
    await context.close();
    console.log(`PASS ${viewport.width}px: picker, selection persistence, search, draft recovery, streamed reply, rename, saved history, no horizontal overflow or browser errors`);
  }
  const unfunded = await fixture({ OPENAI_API_KEY: "" });
  try {
    const page = await browser.newPage();
    await page.goto(unfunded.origin);
    await page.getByLabel("Message", { exact: true }).fill("Keep this draft");
    await page.getByLabel("Send message", { exact: true }).click();
    await page.getByText("Chat access is not enabled yet. Please try again later.", { exact: true }).waitFor();
    assert.equal(await page.getByLabel("Message", { exact: true }).inputValue(), "Keep this draft");
    assert.equal(unfunded.calls.length, 0);
    await page.close();
    console.log("PASS unconfigured provider: clear error, draft preserved, no provider call");
  } finally { await unfunded.close(); }
} finally {
  await browser.close();
  await app.close();
}
