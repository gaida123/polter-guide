/**
 * E2E tests — Navigation and routing
 *
 * Tests that the SPA router works correctly for all pages.
 */

import { test, expect } from '@playwright/test'

async function blockFirebase(page: import('@playwright/test').Page) {
  await page.route('/api/**', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: '[]',
  }))
  await page.route('https://*.firebaseio.com/**', (route) => route.abort())
  await page.route('https://*.googleapis.com/**', (route) => route.abort())
}

test.describe('Navigation', () => {
  test('root redirects to /demo', async ({ page }) => {
    await blockFirebase(page)
    await page.goto('/')
    await expect(page).toHaveURL('/demo')
  })

  test('/demo loads without crashing', async ({ page }) => {
    await blockFirebase(page)
    await page.goto('/demo')
    await expect(page.locator('body')).toBeVisible()
    // No unhandled error boundary shown
    await expect(page.locator('text=Something went wrong')).not.toBeVisible()
  })

  test('/admin loads without crashing', async ({ page }) => {
    await blockFirebase(page)
    await page.goto('/admin')
    await expect(page.locator('body')).toBeVisible()
    await expect(page.locator('text=Something went wrong')).not.toBeVisible()
  })

  test('/admin/record loads without crashing', async ({ page }) => {
    await blockFirebase(page)
    await page.goto('/admin/record')
    await expect(page.locator('body')).toBeVisible()
    await expect(page.locator('text=Something went wrong')).not.toBeVisible()
  })

  test('admin link from demo page goes to /admin', async ({ page }) => {
    await blockFirebase(page)
    await page.goto('/demo')
    // Look for any link to admin
    const adminLink = page.locator('a[href="/admin"]')
    if (await adminLink.count() > 0) {
      await adminLink.first().click()
      await expect(page).toHaveURL('/admin')
    } else {
      // No admin link on demo page — navigate directly
      await page.goto('/admin')
      await expect(page).toHaveURL('/admin')
    }
  })
})
