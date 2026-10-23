// Shared steps for the browser tests: open the player, wait for real playback, seek, use the chrome menus.
import { expect } from './fixtures.js'

export const direct = 'Playback.S01E01.mp4'
export const remux = 'Playback.S01E02.mkv'
export const scope = 'Playback.S01E04.mp4' // 478×200, 2.39:1
export const long = 'Playback.S02E01.mkv' // 10 minutes, 160×90: conversion pauses long before the end
export const unindexed = 'Playback.S02E02.ts' // no keyframe index: a growing playlist
/** The player's HLS session as the status poll reports it. */
export const sessionStatus = async (page, app, decision) =>
  (await (await page.request.get(`${app.origin}/api/torrents/${app.ih}/status?session=${decision.session}`)).json()).session
/** Counts /api/play requests from now on. */
export function countPlays (page) {
  const plays = []
  page.on('request', r => { if (r.url().endsWith('/api/play') && r.method() === 'POST') plays.push(r.postDataJSON()) })
  return plays
}
export const playResponse = page => page.waitForResponse(r => r.url().endsWith('/api/play') && r.request().method() === 'POST')

export async function expectPlaying (page, width = 320) {
  await expect.poll(() => page.locator('#video').evaluate(v => ({
    ready: v.readyState >= 2,
    playing: !v.paused,
    width: v.videoWidth,
    frames: v.getVideoPlaybackQuality().totalVideoFrames > 0,
    error: v.error?.message ?? null,
  }))).toEqual({ ready: true, playing: true, width, frames: true, error: null })
  const frames = await page.locator('#video').evaluate(v => v.getVideoPlaybackQuality().totalVideoFrames)
  await expect.poll(() => page.locator('#video').evaluate(v => v.getVideoPlaybackQuality().totalVideoFrames)).toBeGreaterThan(frames)
}

export async function openPlayer (page, app, file, width = 320) {
  const response = playResponse(page)
  await page.goto(app.player(file))
  const res = await response
  expect(res.ok(), await res.text()).toBeTruthy()
  const decision = await res.json()
  await expectPlaying(page, width)
  return decision
}

export async function seek (page, seconds) {
  await page.locator('#seek').evaluate((input, seconds) => {
    input.value = seconds
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
  }, seconds)
  // The slider keeps the dragged value until the next timeupdate publishes the
  // real position; wait for one tick so polls can't pass on the stale value.
  // Bounded: a seek into a part the server is still converting has no ticks until then.
  await page.locator('#video').evaluate(v => new Promise(resolve => {
    const timer = setTimeout(resolve, 5000)
    v.addEventListener('timeupdate', () => { clearTimeout(timer); resolve() }, { once: true })
  }))
}

/** Moves the pointer over the video, which shows the chrome for 2.5 s if it had faded out. */
export async function showChrome (page) {
  await page.locator('#stage').hover({ position: { x: 20, y: 20 } })
  await expect(page.locator('#stage')).not.toHaveClass(/idle/)
}

/**
 * Picks a choice in one of the chrome's menus (audio-slot, subs-slot…) by its data-value, with the keyboard.
 * Focus inside the chrome keeps it showing, so a busy machine can't fade it out between two pointer clicks.
 */
export async function choose (page, slot, value) {
  const summary = page.locator(`#${slot} summary`)
  await summary.focus()
  if (await summary.getAttribute('aria-expanded') !== 'true') await page.keyboard.press('Enter')
  await expect(summary).toHaveAttribute('aria-expanded', 'true')
  const item = page.locator(`#${slot} .menu-items [data-value="${value}"]`)
  await item.focus()
  await page.keyboard.press('Enter')
  // The menu is redrawn with the new choice checked; wait for it so the next step sees the new state
  await expect(page.locator(`#${slot} .menu-items [data-value="${value}"][aria-checked="true"]`)).toHaveCount(1)
  await expect(summary).toHaveAttribute('aria-expanded', 'false') // choosing closes the menu
}
export const chooseAudio = (page, track) => choose(page, 'audio-slot', String(track))
export const chooseSubtitles = (page, value) => choose(page, 'subs-slot', value)

export async function expectCues (page, text) {
  await expect.poll(() => page.locator('#video').evaluate(v =>
    [...v.textTracks[0].cues ?? []].map(c => c.text))).toContain(text)
}
