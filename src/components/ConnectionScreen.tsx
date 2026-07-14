import { useState, type FormEvent } from 'react'
import { ArrowRight, Database, Eye, EyeOff, KeyRound, LoaderCircle, LockKeyhole, Plus, Server } from 'lucide-react'
import { createConnection } from '../api'
import type { Connection } from '../types'

type Props = {
  connections: Connection[]
  loading: boolean
  startupError?: string
  onConnect: (connection: Connection) => Promise<void>
  onCreated: (connection: Connection) => void
}

const initialValues = {
  name: '', endpoint: 'https://', bucket: '', region: '', accessKeyId: '', secretAccessKey: '', forcePathStyle: true,
}

export function ConnectionScreen({ connections, loading, startupError, onConnect, onCreated }: Props) {
  const [showForm, setShowForm] = useState(connections.length === 0)
  const [showSecret, setShowSecret] = useState(false)
  const [values, setValues] = useState(initialValues)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      const connection = await createConnection(values)
      onCreated(connection)
      await onConnect(connection)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Не удалось подключиться')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="connect-page">
      <div className="connect-glow connect-glow-one" />
      <div className="connect-glow connect-glow-two" />
      <header className="connect-header">
        <div className="brand-mark"><Database size={20} /></div>
        <span className="brand-name">Drift</span>
        <span className="brand-tag">S3 browser</span>
      </header>

      <section className="connect-layout">
        <div className="connect-copy">
          <span className="eyebrow"><LockKeyhole size={14} /> Приватно по умолчанию</span>
          <h1>Ваши файлы.<br /><em>Без лишнего шума.</em></h1>
          <p>Подключайте S3-совместимые хранилища, разбирайте папки и просматривайте файлы в одном спокойном рабочем пространстве.</p>
          <div className="security-note">
            <KeyRound size={18} />
            <div><strong>Ключи остаются на сервере</strong><span>Они не сохраняются в браузере и исчезают после перезапуска.</span></div>
          </div>
        </div>

        <div className="connect-card">
          <div className="connect-card-head">
            <div><span className="step-label">Подключение</span><h2>{showForm ? 'Новый бакет' : 'Выберите хранилище'}</h2></div>
            {connections.length > 0 && (
              <button className="icon-button" type="button" onClick={() => { setShowForm(!showForm); setError('') }} aria-label="Новое подключение">
                {showForm ? <ArrowRight className="rotate-180" size={19} /> : <Plus size={19} />}
              </button>
            )}
          </div>

          {startupError && <div className="backend-warning"><Server size={17} /><span><strong>Backend не отвечает</strong>{startupError}</span></div>}

          {!showForm ? (
            <div className="connection-list">
              {connections.map((connection) => (
                <button key={connection.id} className="connection-option" disabled={loading} onClick={() => onConnect(connection)}>
                  <span className="connection-icon"><Server size={20} /></span>
                  <span><strong>{connection.name}</strong><small>{connection.bucket} · {connection.region}</small></span>
                  <ArrowRight size={18} />
                </button>
              ))}
              <button className="text-button" onClick={() => setShowForm(true)}><Plus size={16} /> Подключить другой бакет</button>
            </div>
          ) : (
            <form className="connection-form" onSubmit={submit}>
              <label><span>Название <small>необязательно</small></span><input value={values.name} onChange={(e) => setValues({ ...values, name: e.target.value })} placeholder="Моё хранилище" /></label>
              <label><span>S3 URL</span><input required type="url" value={values.endpoint} onChange={(e) => setValues({ ...values, endpoint: e.target.value })} placeholder="https://s3.example.com" /></label>
              <div className="form-row">
                <label><span>Бакет</span><input required value={values.bucket} onChange={(e) => setValues({ ...values, bucket: e.target.value })} placeholder="bucket-name" /></label>
                <label><span>Регион</span><input required value={values.region} onChange={(e) => setValues({ ...values, region: e.target.value })} placeholder="us-east-1" /></label>
              </div>
              <label><span>Access Key</span><input required autoComplete="off" value={values.accessKeyId} onChange={(e) => setValues({ ...values, accessKeyId: e.target.value })} placeholder="Access key ID" /></label>
              <label><span>Secret Key</span><div className="secret-input"><input required autoComplete="new-password" type={showSecret ? 'text' : 'password'} value={values.secretAccessKey} onChange={(e) => setValues({ ...values, secretAccessKey: e.target.value })} placeholder="Secret access key" /><button type="button" onClick={() => setShowSecret(!showSecret)}>{showSecret ? <EyeOff size={17} /> : <Eye size={17} />}</button></div></label>
              <label className="checkbox-label"><input type="checkbox" checked={values.forcePathStyle} onChange={(e) => setValues({ ...values, forcePathStyle: e.target.checked })} /><span><strong>Path-style адресация</strong><small>Подходит большинству S3-совместимых сервисов</small></span></label>
              {error && <div className="form-error">{error}</div>}
              <button className="primary-button connect-submit" disabled={busy}>{busy ? <LoaderCircle className="spin" size={18} /> : <Server size={18} />} Проверить и подключить</button>
            </form>
          )}
        </div>
      </section>
      <footer className="connect-footer">Drift не ведёт аналитику и не отправляет параметры подключения третьим лицам.</footer>
    </main>
  )
}
