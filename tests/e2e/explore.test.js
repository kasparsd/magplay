import { test, expect } from './fixtures.js'

// The fixtures have no BitMagnet, so Explore's API answers come from these recorded shapes.
const title = (id, name, year, extra = {}) => ({
  type: 'movie',
  source: 'tmdb',
  id: String(id),
  title: name,
  year,
  rating: 7.1,
  runtime: 100,
  overview: `${name} overview.`,
  genres: ['Drama'],
  links: [{ source: 'imdb', url: 'https://www.imdb.com/title/tt0000001/' }],
  seeders: 10,
  playable: true,
  best: 'a'.repeat(40),
  ...extra,
})
const release = (hash, name, seeders, playbackEffort) => ({
  infoHash: hash.repeat(40), name, size: 1e9, seeders, episode: null, publishedAt: null, badges: ['1080p'], likelyDirect: false, playbackEffort, warning: null,
})

async function fakeExplore (page) {
  const requests = []
  await page.route('**/api/explore/facets?*', route => route.fulfill({
    json: {
      genres: [{ value: 'Drama', label: 'Drama', count: 12 }, { value: 'Comedy', label: 'Comedy', count: 5, estimate: true }],
      years: [{ value: 2010, count: 3 }, { value: 2009, count: 1 }],
      resolutions: [{ value: 'V720p', count: 1 }, { value: 'V1080p', count: 2 }],
    }
  }))
  await page.route('**/api/explore/latest?*', route => route.fulfill({ json: [{ ...release('c', 'Latest.Release.1080p', 3, null), title: null }] }))
  await page.route('**/api/explore?*', route => {
    const url = new URL(route.request().url())
    requests.push(url.searchParams)
    const pageNo = url.searchParams.get('page')
    return route.fulfill({
      json: pageNo === '1'
        ? { titles: [title(1, 'Sample Film', 2010), title(2, 'Other Film', 2009)], hasMore: true }
        : { titles: [title(2, 'Other Film', 2009), title(3, 'Third Film', 2010)], hasMore: false }
    })
  })
  await page.route('**/api/title/**', route => route.fulfill({
    json: {
      ...title(1, 'Sample Film', 2010),
      releases: [release('d', 'Sample.Film.2010.2160p.HEVC', 50, 'transcode'), release('e', 'Sample.Film.2010.1080p.x264', 20, 'direct')],
      truncated: true,
    }
  }))
  return requests
}

test('Explore keeps its filters in the URL, steps back through them, and adds more tiles without repeats', async ({ page, app }) => {
  const requests = await fakeExplore(page)
  await page.goto(`${app.origin}/explore`)
  await expect(page.locator('#tiles .tile')).toHaveCount(2)
  await expect(page.locator('#latest')).toContainText('Latest.Release.1080p')
  // Only exact counts are shown
  await expect(page.locator('#genres')).toContainText('Drama 12')
  await expect(page.getByRole('button', { name: 'Comedy', exact: true })).toBeVisible()

  await page.getByRole('button', { name: 'Drama 12' }).click()
  await expect(page).toHaveURL(`${app.origin}/explore?genre=Drama`)
  await expect(page.getByRole('button', { name: 'Drama 12' })).toHaveAttribute('aria-pressed', 'true')
  await page.getByRole('combobox', { name: 'Year' }).selectOption('2010')
  await expect(page).toHaveURL(`${app.origin}/explore?genre=Drama&year=2010`)
  expect(Object.fromEntries(requests.at(-1))).toEqual({ type: 'movie', sort: 'seeders', genre: 'Drama', year: '2010', page: '1' })

  await page.getByRole('button', { name: 'Show more' }).click()
  await expect(page.locator('#tiles .tile')).toHaveCount(3)
  await expect(page.getByRole('button', { name: 'Show more' })).toBeHidden()

  await page.goBack()
  await expect(page).toHaveURL(`${app.origin}/explore?genre=Drama`)
  await expect(page.getByRole('combobox', { name: 'Year' })).toHaveValue('')
  // A new type starts without the previous type's genre
  await page.getByRole('combobox', { name: 'Type' }).selectOption('tv_show')
  await expect(page).toHaveURL(`${app.origin}/explore?type=tv_show`)
})

test('a title opened from Explore lists its releases best first and goes back to the same filters', async ({ page, app }) => {
  await fakeExplore(page)
  await page.goto(`${app.origin}/explore?year=2010`)
  await page.getByRole('link', { name: /Sample Film/ }).click()
  await expect(page).toHaveURL(`${app.origin}/title/movie/tmdb/1?title=Sample+Film&year=2010`)
  await expect(page).toHaveTitle('Sample Film · magplay')
  await expect(page.locator('#header h1')).toHaveText('Sample Film 2010')
  await expect(page.locator('#releases h2')).toHaveText('2 releases')
  // Most seeded first; the playable one is the best release
  await expect(page.locator('#releases li').first()).toContainText('Sample.Film.2010.2160p.HEVC')
  await expect(page.locator('#releases li', { hasText: '1080p.x264' })).toContainText('best')
  await expect(page.getByRole('link', { name: '▶ Best release' })).toHaveAttribute('href', /^\/t\/e{40}\?title=/)
  await expect(page.getByRole('link', { name: 'Search all sources' }).first()).toHaveAttribute('href', '/?q=Sample+Film+2010')
  await expect(page.locator('#releases .truncated')).toContainText('BitMagnet has more')

  await page.getByRole('link', { name: '← Explore' }).click()
  await expect(page).toHaveURL(`${app.origin}/explore?year=2010`)
  await expect(page.locator('#tiles .tile')).toHaveCount(2)

  // A direct visit goes to Explore for its type
  await page.goto(`${app.origin}/title/movie/tmdb/1?title=Sample+Film`)
  await expect(page.locator('#back')).toHaveAttribute('href', '/explore')
})
