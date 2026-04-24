import React, { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import api from '../api'

export default function CallbackPage() {
  const navigate = useNavigate()

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const code = params.get('code')
    if (!code) return

    api.get(`/api/auth/callback?code=${code}`)
      .then(res => {
        localStorage.setItem('token', res.data.token)
        navigate('/home')
      })
      .catch(err => console.error('Auth error', err))
  }, [])

  return <p>Authenticating...</p>
}
