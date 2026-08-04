import { useState, useEffect } from 'react'
import NowPlaying from './NowPlaying'
import Queue from './Queue'
import { useNowPlaying } from './useNowPlaying'

const FINGERPRINT_KEY = 'spotiqueue.fingerprint.v1'

function getFingerprintId() {
    try {
        let id = localStorage.getItem(FINGERPRINT_KEY)
        if (!id) {
            id = crypto.randomUUID
                ? crypto.randomUUID()
                : `${Date.now()}-${Math.random().toString(36).slice(2)}`
            localStorage.setItem(FINGERPRINT_KEY, id)
        }
        return id
    } catch (e) {
        return null
    }
}

function QueuePage() {
    const nowPlaying = useNowPlaying()
    const [fingerprintId, setFingerprintId] = useState(null)

    useEffect(() => {
        setFingerprintId(getFingerprintId())
    }, [])

    return (
        <div className="min-h-screen bg-background">
            <main className="container mx-auto px-4 pb-8">
                <NowPlaying track={nowPlaying} />
                <Queue fingerprintId={fingerprintId} />
            </main>
        </div>
    )
}

export default QueuePage