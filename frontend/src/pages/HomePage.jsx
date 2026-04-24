import React, { useState } from 'react'
import api from '../api'

export default function HomePage() {
  const [playlistId, setPlaylistId] = useState('')
  const [tracks, setTracks] = useState([])
  const [error, setError] = useState('')

  const fetchPlaylist = async () => {
    setError('')
    setTracks([])
    try {
      const token = localStorage.getItem('token')
      const res = await api.get('/api/playlist/tracks', {
        params: { playlist: playlistId },
        headers: { Authorization: `Bearer ${token}` },
      })
      setTracks(res.data.tracks || [])
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to fetch playlist')
    }
  }

  return (
    <div>
      <h1>PlaylistFilter</h1>
      <input
        value={playlistId}
        onChange={e => setPlaylistId(e.target.value)}
        placeholder="Spotify playlist URL or ID"
        style={{ width: '300px' }}
      />
      <button onClick={fetchPlaylist}>Fetch Playlist</button>
      {error && <p style={{ color: 'red' }}>{error}</p>}
      <ul>
        {tracks.map(t => (
          <li key={t.id}>{t.name} — {t.artist}</li>
        ))}
      </ul>
    </div>
  )
}
