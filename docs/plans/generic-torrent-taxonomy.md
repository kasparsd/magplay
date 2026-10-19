# Generic torrent client taxonomy

## Goal

Make magplay a generic torrent client focused on streaming video/audio while still handling downloads like Linux ISOs and other content. Discovery filters should cover more than movies and TV.

## Taxonomy

BitMagnet content types (Explore):

- Video: `movie`, `tv_show`
- Audio: `music`, `audiobook`
- Reading: `ebook` (shown as Books), `comic`
- Software and games: `game`, `software` (Linux ISOs classify as `software`)
- Adult: `xxx`
- Uncategorized: `unknown`

Torznab search categories (search page):

- All
- Movies: `2000`
- TV: `5000`
- Audio: `3000`
- Software: `4000`
- Books: `7000`
- Other: `8000`

## Progress

- [x] Expand BitMagnet `TYPES` to all content types.
- [x] Update `ExploreType` contract.
- [x] Update Explore UI to a type selector with grouped options.
- [x] Add Audio, Software, Books and Other search categories.
- [ ] Adjust playback/download UX messaging for non-media content.
- [ ] Align the adult-setting help with its actual Explore/title coverage; generic Torznab/Prowlarr search has no adult filtering today.
- [x] Put adult Explore/title content behind `content.showAdult` (env `SHOW_ADULT_CONTENT`/`ALLOW_ADULT` or Settings toggle, default off).
