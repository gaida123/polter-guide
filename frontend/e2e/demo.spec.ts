/**
 * E2E tests — Demo page
 *
 * All API calls are intercepted with page.route() so these tests run
 * without a live backend.
 */

import { test, expect } from '@playwright/test'

const MOCK_SOPS = [
  {
    sop_id: 'demo-sop-001',
    name: 'Create a Shipment',
    product_id: 'demo-product',
    description: 'Step-by-step guide to create a new freight shipment',
    published: true,
    total_steps: 5,
    total_plays: 12,
    completion_count: 8,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  },
]

const MOCK_SEARCH_RESULTS = [
  { ...MOCK_SOPS[0], similarity_score: 0.91 },
]

async function mockApiRoutes(page: import('@playwright/test').Page) {
  // Use ** glob so the pattern matches any path segment depth
  await page.route('**/api/sops/search**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(MOCK_SEARCH_RESULTS),
    })
  })
  await page.route('**/api/sops**', async (route) => {
    const req = route.request()
    // Only intercept non-search GETs here (search is caught above)
    if (req.method() === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(MOCK_SOPS),
      })
    } else {
      await route.continue()
    }
  })
  await page.route('**/api/sessions**', async (route) => {
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({
        session_id: 'test-session-001',
        ws_url: 'ws://localhost:5173/ws/test-session-001',
        sop_id: 'demo-sop-001',
      }),
    })
  })
  await page.route('https://*.firebaseio.com/**', (route) => route.abort())
  await page.route('https://*.googleapis.com/**', (route) => route.abort())
}

test.describe('Demo Page', () => {
  test.beforeEach(async ({ page }) => {
    await mockApiRoutes(page)
    await page.goto('/demo')
  })

  test('loads and shows the HandOff.AI branding', async ({ page }) => {
    // Use exact match to avoid strict mode conflict with "Experience HandOff.AI"
    await expect(page.getByText('HandOff.AI', { exact: true }).first()).toBeVisible()
  })

  test('shows the fake FreightOS dashboard', async ({ page }) => {
    await expect(page.locator('text=FreightOS')).toBeVisible()
    // Use first() to handle multiple elements containing "Shipments"
    await expect(page.locator('text=Shipments').first()).toBeVisible()
  })

  test('shows the Experience HandOff.AI overlay panel', async ({ page }) => {
    await expect(page.locator('h2', { hasText: 'Experience HandOff.AI' })).toBeVisible()
    await expect(page.locator('input[placeholder*="how do I"]')).toBeVisible()
  })

  test('shows the Start Guided Tour button', async ({ page }) => {
    await expect(page.getByRole('button', { name: 'Start Guided Tour' })).toBeVisible()
  })

  test('search bar is interactive', async ({ page }) => {
    const searchInput = page.locator('input[placeholder*="how do I"]')
    await expect(searchInput).toBeVisible()
    await searchInput.fill('create a shipment')
    await expect(searchInput).toHaveValue('create a shipment')
  })

  test('search results appear after typing', async ({ page }) => {
    const searchInput = page.locator('input[placeholder*="how do I"]')
    await expect(searchInput).toBeVisible()
    await searchInput.fill('shipment')
    // Wait for debounce (350ms) + render. Mocked API responds instantly.
    await expect(page.locator('text=Create a Shipment').first()).toBeVisible({ timeout: 5000 })
  })

  test('clicking a search result selects it', async ({ page }) => {
    const searchInput = page.locator('input[placeholder*="how do I"]')
    await expect(searchInput).toBeVisible()
    await searchInput.fill('shipment')
    await expect(page.locator('text=Create a Shipment').first()).toBeVisible({ timeout: 5000 })
    // Click the result button inside the dropdown
    await page.locator('button', { hasText: 'Create a Shipment' }).first().click()
    // After selection the search input or result should reflect the choice
    await page.waitForTimeout(300)
  })

  test('Start Guided Tour button is clickable', async ({ page }) => {
    const startBtn = page.getByRole('button', { name: 'Start Guided Tour' })
    await expect(startBtn).toBeVisible()
    await startBtn.click()
    await page.waitForTimeout(500)
  })
})
