import { expect, test } from "@playwright/test";

// Disposable browser-harness identity; no real Clerk account or delivery.
for (const viewport of [
  { width: 390, height: 844, label: "phone" },
  { width: 768, height: 1024, label: "tablet" },
  { width: 1280, height: 900, label: "desktop" },
]) {
  test(`retired register stays absent and policy/history navigation works on ${viewport.label}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const requirementRequests: string[] = [];
    page.on("request", request => {
      if (/\/api\/governance\/requirements(?:\/|$)/.test(request.url())) requirementRequests.push(request.url());
    });
    await page.goto("/");
    await page.getByRole("button", { name: /Demo Reviewer/ }).click();
    await page.getByRole("button", { name: "Sign In", exact: true }).click();
    await expect(page.getByTestId("active-client-name")).toHaveText("Demo Organization");
    await page.goto("/policy-review");
    await expect(page.getByRole("heading", { name: "Governance & Policy Review", exact: true })).toBeVisible();
    await expect(page.getByRole("tab")).toHaveCount(2);
    await expect(page.getByRole("tab", { name: "Policy Decisions", exact: true })).toBeVisible();
    await expect(page.getByText(/Requirements Register|view requirement coverage/i)).toHaveCount(0);
    await expect(page.getByText("Loading decisions...", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Affected cases", exact: true })).toBeVisible();
    await page.getByRole("tab", { name: "Audit history", exact: true }).click();
    await expect(page.getByRole("tab", { name: "Audit history", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("heading", { name: "Review and reminder history", exact: true })).toBeVisible();
    await page.getByRole("tab", { name: "Policy Decisions", exact: true }).click();
    await expect(page.getByRole("tab", { name: "Policy Decisions", exact: true })).toHaveAttribute("aria-selected", "true");
    expect(requirementRequests).toEqual([]);
    const dimensions = await page.evaluate(() => ({
      width: innerWidth, scrollWidth: document.documentElement.scrollWidth,
    }));
    expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.width + 1);
    for (const tab of await page.getByRole("tab").all()) {
      const bounds = await tab.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width);
    }
  });
}
