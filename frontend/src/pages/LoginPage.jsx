import React from 'react'
import api from '../api'

export default function LoginPage() {
  const handleLogin = async () => {
    const res = await api.get('/api/auth/login')
    if (res.data?.url) window.location.href = res.data.url
  }

  return (
    <div>
      <h1>PlaylistFilter</h1>
      <button onClick={handleLogin}>Login with Spotify</button>
    </div>
  )
}
