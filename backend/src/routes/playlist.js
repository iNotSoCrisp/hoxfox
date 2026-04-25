const express = require('express');
const playlistController = require('../controllers/playlistController');

const router = express.Router();

router.get('/', playlistController.getPlaylists);
router.get('/:id', playlistController.getPlaylistTracks);
router.post('/audio-features', playlistController.getAudioFeatures);
router.post('/create', playlistController.createPlaylist);
router.post('/add-tracks', playlistController.addTracksToPlaylist);
router.post('/filter', playlistController.filterPlaylist);

module.exports = router;