/**
 * genreController.js
 * Exposes artist genre lookup as a standalone endpoint.
 * Uses the batched, cached implementation from spotifyService.
 */

const spotifyService = require('../services/spotifyService');

const getArtistsGenres = async (req, res, next) => {
  try {
    const { artistIds } = req.body;
    if (!artistIds || !Array.isArray(artistIds)) {
      return res.status(400).json({ error: 'artistIds must be an array' });
    }

    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'Authorization header missing' });

    const token = authHeader.split(' ')[1];
    const refreshToken = req.headers['x-refresh-token'] || null;

    // Returns { [artistId]: string[] }
    const genres = await spotifyService.getArtistGenresBatched(artistIds, token, refreshToken);
    res.json(genres);
  } catch (error) {
    next(error);
  }
};

module.exports = { getArtistsGenres };
