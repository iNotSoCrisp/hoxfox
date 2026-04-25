/**
 * playlistController.js
 * Handles all playlist-related HTTP endpoints.
 *
 * filterPlaylist implements the full pipeline:
 *   1. Fetch playlist tracks
 *   2. Collect artist IDs → batch-fetch genres (no audio-features API)
 *   3. Normalize tracks into canonical shape
 *   4. Parse user intent (rule-based → LLM fallback)
 *   5. Score, rank, apply diversity filter
 *   6. Return enriched results + explainability metadata
 */

const spotifyService  = require('../services/spotifyService');
const { parseIntent } = require('../services/intentParserService');
const { filterTracks } = require('../services/filterEngineService');
const { normalizeTracks } = require('../utils/normalizeTrack');

// ── Token helpers ──────────────────────────────────────────────────────────
const extractToken = (req) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) throw new Error('Missing token');
  return token;
};

const extractRefreshToken = (req) => req.headers['x-refresh-token'] || null;

// ─────────────────────────────────────────────────────────────────────────────
// GET /playlists
// ─────────────────────────────────────────────────────────────────────────────
exports.getPlaylists = async (req, res) => {
  try {
    const token        = extractToken(req);
    const refreshToken = extractRefreshToken(req);
    const playlists    = await spotifyService.getUserPlaylists(token, refreshToken);
    res.json(playlists);
  } catch (error) {
    console.error('[getPlaylists] error:', error.response?.data || error.message);
    if (error.message === 'Missing token') return res.status(401).json({ error: 'Missing token' });
    res.status(500).json({ error: 'Failed to fetch playlists' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /playlists/:id
// ─────────────────────────────────────────────────────────────────────────────
exports.getPlaylistTracks = async (req, res) => {
  try {
    const token        = extractToken(req);
    const refreshToken = extractRefreshToken(req);
    const playlistId   = req.params.id;
    const tracks       = await spotifyService.getPlaylistTracks(playlistId, token, refreshToken);
    res.json(tracks);
  } catch (error) {
    console.error('[getPlaylistTracks] error:', error.response?.data || error.message);
    if (error.message === 'Missing token') return res.status(401).json({ error: 'Missing token' });
    res.status(500).json({ error: 'Failed to fetch tracks: ' + (error.response?.data?.error?.message || error.message) });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /playlists/create
// ─────────────────────────────────────────────────────────────────────────────
exports.createPlaylist = async (req, res) => {
  try {
    const token        = extractToken(req);
    const refreshToken = extractRefreshToken(req);
    const { userId, name } = req.body;
    if (!userId || !name) return res.status(400).json({ error: 'userId and name are required' });
    const data = await spotifyService.createPlaylist(userId, name, token, refreshToken);
    res.json(data);
  } catch (error) {
    console.error('[createPlaylist] error:', error.response?.data || error.message);
    if (error.message === 'Missing token') return res.status(401).json({ error: 'Missing token' });
    res.status(500).json({ error: 'Failed to create playlist' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /playlists/add-tracks
// ─────────────────────────────────────────────────────────────────────────────
exports.addTracksToPlaylist = async (req, res) => {
  try {
    const token        = extractToken(req);
    const refreshToken = extractRefreshToken(req);
    const { playlistId, uris } = req.body;
    if (!playlistId || !uris || !Array.isArray(uris)) {
      return res.status(400).json({ error: 'playlistId and uris array are required' });
    }
    const data = await spotifyService.addTracksToPlaylist(playlistId, uris, token, refreshToken);
    res.json(data);
  } catch (error) {
    console.error('[addTracksToPlaylist] error:', error.response?.data || error.message);
    if (error.message === 'Missing token') return res.status(401).json({ error: 'Missing token' });
    res.status(500).json({ error: 'Failed to add tracks to playlist' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /playlists/filter    ← MAIN ENDPOINT
//
// Body: { playlistId, query, topN?, maxPerArtist?, createPlaylist? }
// Headers: Authorization: Bearer <token>, x-refresh-token: <token>
//
// Pipeline:
//   1. Fetch all playlist tracks (paginated)
//   2. Collect unique artist IDs → batch-fetch genres (cached, batches of 50)
//   3. Normalize tracks: { id, name, artists, genres, clusters, popularity, … }
//   4. Parse intent: rule-based → LLM fallback
//   5. Score + rank + diversity + fallback
//   6. (Optional) create new playlist and add filtered tracks
//   7. Return
// ─────────────────────────────────────────────────────────────────────────────
exports.filterPlaylist = async (req, res) => {
  try {
    const token        = extractToken(req);
    const refreshToken = extractRefreshToken(req);
    const {
      playlistId,
      query,
      topN         = 30,
      maxPerArtist = 3,
      userId,             // needed if createNewPlaylist is true
      createNewPlaylist = false,
    } = req.body;

    if (!playlistId || !query) {
      return res.status(400).json({ error: 'playlistId and query are required' });
    }

    console.log(`[filterPlaylist] playlist=${playlistId} query="${query}"`);

    // ── Step 1: Fetch all tracks ───────────────────────────────────────────
    const rawItems = await spotifyService.getPlaylistTracks(playlistId, token, refreshToken);
    const rawTracks = rawItems
      .map(item => item.track || item)
      .filter(t => t && t.id && t.id !== 'local'); // drop null + local tracks

    if (rawTracks.length === 0) {
      return res.status(404).json({ error: 'Playlist is empty or has no playable tracks' });
    }

    console.log(`[filterPlaylist] ${rawTracks.length} raw tracks`);

    // ── Step 2: Collect unique artist IDs ────────────────────────────────
    const allArtistIds = [...new Set(
      rawTracks.flatMap(t => (t.artists || []).map(a => a.id).filter(Boolean))
    )];

    console.log(`[filterPlaylist] ${allArtistIds.length} unique artists — fetching genres...`);

    // Batch-fetch genres (50/request, in-memory LRU cached)
    const artistGenreMap = await spotifyService.getArtistGenresBatched(
      allArtistIds, token, refreshToken
    );

    const totalGenresCovered = Object.values(artistGenreMap).filter(g => g.length > 0).length;
    console.log(`[filterPlaylist] genres fetched for ${totalGenresCovered}/${allArtistIds.length} artists`);

    // ── Step 3: Normalize tracks ──────────────────────────────────────────
    const normalizedTracks = normalizeTracks(rawItems, artistGenreMap);

    // Deduplicate by track ID (playlist can have duplicates)
    const seen = new Set();
    const uniqueTracks = normalizedTracks.filter(t => {
      if (seen.has(t.id)) return false;
      seen.add(t.id);
      return true;
    });

    console.log(`[filterPlaylist] ${uniqueTracks.length} unique normalized tracks`);

    // ── Step 4: Parse intent ──────────────────────────────────────────────
    const intent = await parseIntent(query);
    console.log(`[filterPlaylist] intent="${intent.label}" source=${intent.source} genres=${intent.targetGenres.join(',')}`);

    // ── Step 5: Score, rank, diversity, fallback ──────────────────────────
    const result = filterTracks(uniqueTracks, intent, { topN, maxPerArtist });

    console.log(`[filterPlaylist] ${result.tracks.length} tracks selected (relaxed=${result.relaxed})`);

    // ── Step 6 (optional): Create new Spotify playlist ───────────────────
    let newPlaylistId = null;
    if (createNewPlaylist && userId) {
      const playlistName = `${intent.label} — hoxfox`;
      const newPl = await spotifyService.createPlaylist(userId, playlistName, token, refreshToken);
      newPlaylistId = newPl.id;

      const uris = result.tracks
        .map(s => s.track.uri)
        .filter(Boolean);

      // Spotify accepts max 100 URIs per add request
      for (let i = 0; i < uris.length; i += 100) {
        await spotifyService.addTracksToPlaylist(
          newPlaylistId,
          uris.slice(i, i + 100),
          token,
          refreshToken
        );
      }
      console.log(`[filterPlaylist] Created new playlist: ${newPlaylistId}`);
    }

    // ── Step 7: Return ────────────────────────────────────────────────────
    return res.json({
      label:            intent.label,
      intentSource:     intent.source,
      intent: {
        keywords:     intent.keywords,
        targetGenres: intent.targetGenres,
        artist:       intent.artist,
      },
      totalConsidered:  result.totalConsidered,
      totalReturned:    result.tracks.length,
      relaxed:          result.relaxed,
      newPlaylistId,
      tracks: result.tracks.map(s => ({
        id:           s.track.id,
        uri:          s.track.uri,
        name:         s.track.name,
        artists:      s.track.artists,
        genres:       s.track.genres,
        clusters:     s.track.clusters,
        popularity:   s.track.popularity,
        durationMs:   s.track.durationMs,
        album:        s.track.album,
        score:        Math.round(s.score),
        matchReasons: s.matchReasons,
        scoreBreakdown: s.components,
      })),
    });

  } catch (error) {
    console.error('[filterPlaylist] error:', error.response?.data || error.message);
    if (error.message === 'Missing token') return res.status(401).json({ error: 'Missing token' });
    res.status(500).json({ error: error.message || 'Failed to filter playlist' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /playlists/audio-features  (kept for backwards compat, returns 410)
// ─────────────────────────────────────────────────────────────────────────────
exports.getAudioFeatures = async (req, res) => {
  res.status(410).json({
    error: 'audio-features endpoint is no longer used. Use /playlists/filter instead.',
  });
};