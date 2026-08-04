import { useEffect, useState } from 'react'
import axios from '@/lib/api'

let currentTrack = null
let subscribers = new Set()
let intervalId = null

function notify() {
    subscribers.forEach((cb) => cb(currentTrack))
}

async function poll() {
    try {
        const response = await axios.get('/api/now-playing')
        currentTrack = response.data.track
    } catch (error) {
        console.error('Error fetching now playing:', error)
    }
    notify()
}

function subscribe(cb) {
    subscribers.add(cb)
    if (!intervalId) {
        poll()
        intervalId = setInterval(poll, 3000)
    }
    cb(currentTrack)

    return () => {
        subscribers.delete(cb)
        if (subscribers.size === 0 && intervalId) {
            clearInterval(intervalId)
            intervalId = null
        }
    }
}

export function useNowPlaying() {
    const [track, setTrack] = useState(currentTrack)

    useEffect(() => {
        return subscribe(setTrack)
    }, [])

    return track
}