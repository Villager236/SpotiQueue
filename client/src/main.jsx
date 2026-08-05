import React from 'react'
import ReactDOM from 'react-dom/client'
import { ThemeProvider } from './components/theme-provider'
import './index.css'
import App from './App'
import Display from './components/Display'
import Karaoke from './components/Karaoke'

const root = ReactDOM.createRoot(document.getElementById('root'))

function routeFor(suffix) {
  if (typeof window === 'undefined') return false
  const path = window.location.pathname.replace(/\/$/, '')
    return path.endsWith(suffix)
}

function Root() {
    if (routeFor('/karaoke')) return <Karaoke />
    if (routeFor('/display')) return <Display />
    return (
    <ThemeProvider defaultTheme="system" storageKey="spotiqueue-theme">
      <App />
    </ThemeProvider>
  )
}

root.render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>
)
