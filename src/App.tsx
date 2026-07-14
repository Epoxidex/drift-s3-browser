import { useEffect, useState } from 'react'
import { Database, LoaderCircle } from 'lucide-react'
import { clearActiveConnection, getConnections, setActiveConnection } from './api'
import { Browser } from './components/Browser'
import { ConnectionScreen } from './components/ConnectionScreen'
import type { Connection } from './types'

export default function App() {
  const [connections, setConnections] = useState<Connection[]>([])
  const [active, setActive] = useState<Connection | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let current = true
    getConnections().then(async (items) => {
      if (!current) return
      setConnections(items)
      const savedId = sessionStorage.getItem('s3-connection-id')
      const saved = items.find((item) => item.id === savedId)
      if (saved) {
        await setActiveConnection(saved.id)
        if (current) setActive(saved)
      }
    }).catch(() => undefined).finally(() => current && setLoading(false))
    return () => { current = false }
  }, [])

  async function connect(connection: Connection) {
    setLoading(true)
    try {
      await setActiveConnection(connection.id)
      setActive(connection)
    } finally {
      setLoading(false)
    }
  }

  function disconnect() {
    clearActiveConnection()
    setActive(null)
  }

  if (loading) {
    return <main className="app-loading"><div className="brand-mark"><Database size={20} /></div><strong>Drift</strong><LoaderCircle className="spin" size={18} /></main>
  }

  if (active) return <Browser connection={active} onDisconnect={disconnect} />

  return (
    <ConnectionScreen
      connections={connections}
      loading={loading}
      onConnect={connect}
      onCreated={(connection) => setConnections((items) => [...items, connection])}
    />
  )
}
