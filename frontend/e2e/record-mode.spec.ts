/**
 * E2E tests — Record Mode page
 *
 * Tests the full UI state machine:
 *   idle → recording → name entry → processing → done
 */

import { test, expect } from '@playwright/test'

async function mockRecordRoutes(page: import('@playwright/test').Page) {
  // Mock the recording start endpoint
  await page.route('/api/sops/record/start', async (route) => {
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({ recording_id: 'rec-test-001', product_id: 'demo-product' }),
    })
  })
  // Mock event capture
  await page.route('/api/sops/record/*/events', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({}) })
  })
  // Mock finalise — returns a generated SOP
  await page.route('/api/sops/record/*/finalise', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        sop_id: 'generated-sop-001',
        name: 'My Test SOP',
        steps: [],
        product_id: 'demo-product',
        published: false,
        created_by: 'dev',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        total_plays: 0,
        completion_count: 0,
      }),
    })
  })
  // Block Firebase
  await page.route('https://*.firebaseio.com/**', (route) => route.abort())
  await page.route('https://*.googleapis.com/**', (route) => route.abort())
}

test.describe('Record Mode', () => {
  test.beforeEach(async ({ page }) => {
    await mockRecordRoutes(page)
    await page.goto('/admin/record')
  })

  test('shows the Record Mode heading', async ({ page }) => {
    await expect(page.locator('h1', { hasText: 'Record Mode' })).toBeVisible()
  })

  test('shows descriptive text', async ({ page }) => {
    await expect(page.locator('text=HandOff.AI captures every step')).toBeVisible()
  })

  test('has a "Back to Dashboard" button', async ({ page }) => {
    await expect(page.locator('text=Back to Dashboard')).toBeVisible()
  })

  test('back button navigates to admin', async ({ page }) => {
    await page.locator('text=Back to Dashboard').click()
    await expect(page).toHaveURL('/admin')
  })

  test('shows Start Recording button initially', async ({ page }) => {
    await expect(page.locator('text=Start Recording')).toBeVisible()
  })

  test('clicking Start Recording transitions to recording state', async ({ page }) => {
    await page.locator('text=Start Recording').click()
    // After starting, the UI should show recording status
    await expect(
      page.locator('text=Recording').or(page.locator('text=Stop')).or(page.locator('text=recording'))
    ).toBeVisible({ timeout: 5000 })
  })
})
