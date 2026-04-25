/**
 * filterEngineService.js
 * Core filtering pipeline: score → rank → diversity → fallback → output.
 *
 * Scoring formula (weights from spec — Artist > Genre > Keyword > Popularity):
 *   score = artistScore * 40
 *         + genreScore  * 35
 *         + keyScore    * 20
 *         + popScore    *  5
 *
 * All component scores are 0–1. Final score is 0–100.
 *
 * Input tracks must be NormalizedTrack objects (see normalizeTrack.js).
 * Intent must be output of parseIntent (keywords, targetGenres, artist).
 */

const { genreMatchScore } = require('../utils/genreClusters');

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────
const SCORE_WEIGHTS = {
  artist:     40,
  genre:      35,
  keyword:    20,
  popularity:  5,
};

const DEFAULT_TOP_N      = 30;
const MIN_RESULTS        = 5;
const MAX_PER_ARTIST     = 3;   // diversity: max tracks per artist in final list
const SCORE_THRESHOLD    = 25;  // out of 100; below this = not relevant
const JITTER_RANGE       = 2;   // ±N points of random noise to break ties naturally

// ─────────────────────────────────────────────────────────────────────────────
// Fuzzy / partial keyword matching
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check if a single keyword appears (partially) in a target string.
 * "night" matches "midnight", "late night", "nighttime".
 */
function fuzzyMatch(keyword, target) {
  if (!keyword || !target) return false;
  return target.includes(keyword);
}

/**
 * Score a track's keyword relevance.
 * Checks track name + artist names against the full keyword list.
 * Returns 0–1.
 */
function keywordScore(track, keywords) {
  if (!keywords || keywords.length === 0) return 0;

  const searchText = [track.nameLower, ...track.artistsLower].join(' ');
  const matches = keywords.filter(kw => fuzzyMatch(kw, searchText)).length;

  // Partial credit: even 1/N match gives non-zero score
  return Math.min(1, matches / Math.max(1, Math.ceil(keywords.length * 0.4)));
}

/**
 * Score an artist match.
 * Returns 1.0 if the intent names a specific artist and the track has that artist.
 * Returns 0 if no artist in intent (will not penalize the track).
 */
function artistScore(track, intentArtist) {
  if (!intentArtist) return 0;
  const ia = intentArtist.toLowerCase().trim();
  return track.artistsLower.some(a => a.includes(ia) || ia.includes(a)) ? 1 : 0;
}

/**
 * Normalize popularity (0–100) to 0–1.
 * Use a square-root curve so mid-popularity tracks still score reasonably.
 */
function popularityScore(popularity) {
  return Math.sqrt((popularity || 0) / 100);
}

// ─────────────────────────────────────────────────────────────────────────────
// Track scorer
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Score a single NormalizedTrack against the parsed intent.
 * Returns { score: 0–100, components: {...}, matchReasons: [...] }
 */
function scoreTrack(track, intent, options = {}) {
  const { keywords = [], targetGenres = [], artist = null } = intent;
  const relaxed = options.relaxed || false;

  // ── Component scores (all 0–1) ───────────────────────────────────────────
  const aScore = artistScore(track, artist);
  const gScore = genreMatchScore(
    track.clusters,
    targetGenres,
    relaxed ? { partial: true } : {}
  );
  const kScore = keywordScore(track, keywords);
  const pScore = popularityScore(track.popularity);

  // ── Weighted total ────────────────────────────────────────────────────────
  // If artist is specified in intent, use artist score prominently.
  // If not, redistribute artist weight to genre + keyword.
  let total;
  if (artist) {
    total =
      aScore * SCORE_WEIGHTS.artist +
      gScore * SCORE_WEIGHTS.genre +
      kScore * SCORE_WEIGHTS.keyword +
      pScore * SCORE_WEIGHTS.popularity;
  } else {
    // No artist constraint — redistribute artist weight to genre (20) + keyword (15) + pop (5)
    total =
      gScore * (SCORE_WEIGHTS.genre + 20) +
      kScore * (SCORE_WEIGHTS.keyword + 15) +
      pScore * (SCORE_WEIGHTS.popularity + 5);
  }

  // ── Explainability ────────────────────────────────────────────────────────
  const matchReasons = [];
  if (aScore > 0)    matchReasons.push(`artist match: ${artist}`);
  if (gScore > 0.5)  matchReasons.push(`genre match: ${track.clusters.join(', ')}`);
  if (gScore > 0 && gScore <= 0.5) matchReasons.push(`partial genre match: ${track.clusters.join(', ')}`);
  if (kScore > 0) {
    const matched = keywords.filter(kw =>
      fuzzyMatch(kw, [track.nameLower, ...track.artistsLower].join(' '))
    );
    matchReasons.push(`keyword match: ${matched.slice(0, 3).join(', ')}`);
  }
  if (matchReasons.length === 0) matchReasons.push('popularity only');

  return {
    score: Math.round(total * 100) / 100,
    components: {
      artist: Math.round(aScore * 100),
      genre:  Math.round(gScore * 100),
      keyword: Math.round(kScore * 100),
      popularity: Math.round(pScore * 100),
    },
    matchReasons,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Score normalization
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Normalize scores to 0–100 range using min–max scaling.
 * If all scores are equal, leaves them unchanged.
 */
function normalizeScores(scored) {
  if (scored.length === 0) return scored;
  const max = Math.max(...scored.map(s => s.score));
  const min = Math.min(...scored.map(s => s.score));
  const range = max - min;
  if (range === 0) return scored;

  return scored.map(s => ({
    ...s,
    score: Math.round(((s.score - min) / range) * 100),
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Diversity filter
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Cap number of tracks per artist to maxPerArtist.
 * Operates on an already-sorted array to keep best tracks per artist.
 */
function applyDiversityFilter(scored, maxPerArtist = MAX_PER_ARTIST) {
  const artistCounts = {};
  return scored.filter(({ track }) => {
    // Use the primary artist (first in list)
    const primaryArtist = track.artists[0] || 'unknown';
    artistCounts[primaryArtist] = (artistCounts[primaryArtist] || 0) + 1;
    return artistCounts[primaryArtist] <= maxPerArtist;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Jitter (anti-repetition randomness)
// ─────────────────────────────────────────────────────────────────────────────

function addJitter(scored) {
  return scored.map(s => ({
    ...s,
    score: s.score + (Math.random() * JITTER_RANGE * 2 - JITTER_RANGE),
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Fallback: relax genre requirement
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Re-score with relaxed mode (partial genre match accepted, lower threshold).
 */
function scoreAllRelaxed(tracks, intent) {
  return tracks
    .map(track => {
      const result = scoreTrack(track, intent, { relaxed: true });
      return { track, ...result };
    })
    .filter(s => s.score >= SCORE_THRESHOLD * 0.5)
    .sort((a, b) => b.score - a.score);
}

// ─────────────────────────────────────────────────────────────────────────────
// Main entry point
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Filter, rank, and select tracks from a normalized playlist.
 *
 * @param {object[]} tracks   - NormalizedTrack[]
 * @param {object}   intent   - { keywords, targetGenres, artist }
 * @param {object}   options  - { topN, maxPerArtist }
 * @returns {{
 *   tracks: Array<{ track, score, components, matchReasons }>,
 *   totalConsidered: number,
 *   relaxed: boolean
 * }}
 */
function filterTracks(tracks, intent, options = {}) {
  const topN         = options.topN || DEFAULT_TOP_N;
  const maxPerArtist = options.maxPerArtist || MAX_PER_ARTIST;

  // ── 1. Score all tracks ───────────────────────────────────────────────────
  let scored = tracks.map(track => {
    const result = scoreTrack(track, intent);
    return { track, ...result };
  });

  // ── 2. Filter by threshold ────────────────────────────────────────────────
  let filtered = scored.filter(s => s.score >= SCORE_THRESHOLD);
  let relaxed  = false;

  // ── 3. Fallback: relax if too few results ─────────────────────────────────
  if (filtered.length < MIN_RESULTS) {
    console.log(`[filter] Only ${filtered.length} tracks above threshold — relaxing filters`);
    relaxed  = true;
    filtered = scoreAllRelaxed(tracks, intent);
    
    // If STILL fewer than MIN_RESULTS, just take the top highest-scoring tracks overall 
    // regardless of the threshold, so we don't return an empty playlist.
    if (filtered.length < MIN_RESULTS) {
      filtered = [...scored].sort((a, b) => b.score - a.score);
    }
  }

  // ── 4. Sort by score ──────────────────────────────────────────────────────
  filtered.sort((a, b) => b.score - a.score);

  // ── 5. Normalize scores to 0–100 range ───────────────────────────────────
  filtered = normalizeScores(filtered);

  // ── 6. Add jitter for natural variety ────────────────────────────────────
  filtered = addJitter(filtered);
  filtered.sort((a, b) => b.score - a.score);

  // ── 7. Diversity: cap per-artist ──────────────────────────────────────────
  filtered = applyDiversityFilter(filtered, maxPerArtist);

  // ── 8. Take top N ────────────────────────────────────────────────────────
  const selected = filtered.slice(0, topN);

  return {
    tracks:          selected,
    totalConsidered: tracks.length,
    relaxed,
  };
}

module.exports = { filterTracks, scoreTrack, softScore: popularityScore };
