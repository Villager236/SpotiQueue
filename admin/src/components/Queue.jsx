import { useState, useEffect } from 'react'
import axios from '@/lib/api'

const CACHE_KEY = 'spotiqueue.queue.current.v1'
const CACHE_TTL = 30000

function readCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (!raw) return null
    const { data, expires } = JSON.parse(raw)
    if (Date.now() < expires) return data
  } catch (e) { /* ignore */ }
  return null
}

function writeCache(data) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({
      data,
      expires: Date.now() + CACHE_TTL
    }))
  } catch (e) { /* ignore */ }
}

function Queue({ fingerprintId }) {
  const [queue, setQueue] = useState(null)
  const [loading, setLoading] = useState(true)

  const fetchQueue = async () => {
    try {
      const res = await axios.get('/api/queue/current')
      setQueue(res.data)
      writeCache(res.data)
    } catch (e) {
      const cached = readCache()
      if (cached) setQueue(cached)
    }
    finally { setLoading(false) }
  }

  useEffect(() => {
    fetchQueue()
    const qi = setInterval(fetchQueue, 5000)
    return () => { clearInterval(qi)}
  }, [fingerprintId])

  if (loading || !queue) return null

  const upNext = queue.queue || []
  if (upNext.length === 0) return null

  return (
    <div className="mt-6">
      <h2 className="text-lg font-semibold mb-3">Up Next</h2>
      <div className="space-y-2">
        {upNext.slice(0, 20).map((track, i) => (
          <div
            key={track.id}
            className="flex items-center gap-3 p-3 rounded-lg border bg-card"
          >
            <span className="text-sm text-muted-foreground w-6 shrink-0">{i + 1}</span>
            {track.album_art && (
              <img src={track.album_art} alt="" className="w-10 h-10 sm:w-12 sm:h-12 rounded-lg object-cover shrink-0" />
            )}
            <div className="flex-1 min-w-0">
              <div className="font-medium truncate">{track.name}</div>
              <div className="text-sm text-muted-foreground truncate">{track.artists}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

export default Queue
