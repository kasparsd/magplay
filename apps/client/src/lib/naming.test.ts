import { test } from 'node:test'
import assert from 'node:assert/strict'
import { languageFromName, pickByLanguage, releaseName, sameLanguage } from './naming.ts'

test('release names lose years, episodes and technical tags', () => {
  assert.equal(releaseName('Fleabag.S01.1080p.BluRay.x264-SHORTBREHD'), 'Fleabag')
  assert.equal(releaseName('Fleabag.S01E01.1080p.BluRay.x264-SHORTBREHD.mkv'), 'Fleabag')
  assert.equal(releaseName('Big_Buck_Bunny_(2008)_1080p.mov'), 'Big Buck Bunny')
  assert.equal(releaseName('[Group] Some Show - 03 [1080p].mkv'), 'Some Show - 03')
  assert.equal(releaseName('Sintel.2010.2160p.UHD.HEVC'), 'Sintel')
  assert.equal(releaseName('Playback fixtures'), 'Playback fixtures')
  assert.equal(releaseName('2012.1080p.mkv'), '2012') // a title that is a year stays
})

test('subtitle languages from file names', () => {
  assert.equal(languageFromName('Movie.en.srt'), 'en')
  assert.equal(languageFromName('Subs/Movie.eng.forced.srt'), 'eng')
  assert.equal(languageFromName('Movie.srt'), null)
})

test('tracks are picked by language, with two- and three-letter codes matching', () => {
  assert.ok(sameLanguage('en', 'ENG'))
  assert.ok(!sameLanguage('eng', 'est'))
  assert.ok(!sameLanguage(null, 'eng'))
  const tracks = [{ language: null, n: 0 }, { language: 'lav', n: 1 }, { language: 'eng', n: 2 }]
  assert.equal(pickByLanguage(tracks, 'en')?.n, 2)
  assert.equal(pickByLanguage(tracks, 'lav')?.n, 1)
  assert.equal(pickByLanguage(tracks, 'fra'), undefined)
  assert.equal(pickByLanguage(tracks, null), undefined)
})
