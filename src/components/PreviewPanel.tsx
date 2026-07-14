import { lazy, Suspense, useEffect, useState } from 'react'
import { Braces, Download, File, FileText, Image as ImageIcon, Info, LoaderCircle, X } from 'lucide-react'
import { contentUrl, getBinaryPreview, getObjectMeta, getTextPreview } from '../api'
import type { ObjectMeta, S3Object } from '../types'

const PdfPreview = lazy(() => import('./PdfPreview').then((module) => ({ default: module.PdfPreview })))

function formatBytes(value: number) {
  if (!value) return '0 Б'
  const units = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ']
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1)
  return `${new Intl.NumberFormat('ru', { maximumFractionDigits: index ? 1 : 0 }).format(value / 1024 ** index)} ${units[index]}`
}

function previewKind(item: S3Object, meta: ObjectMeta | null) {
  const extension = item.name.split('.').pop()?.toLowerCase() || ''
  if (meta?.contentType.startsWith('image/') && meta.contentType !== 'image/svg+xml') return 'image'
  if (meta?.contentType === 'application/pdf' || extension === 'pdf') return 'pdf'
  if (['txt', 'md', 'json', 'js', 'jsx', 'ts', 'tsx', 'css', 'html', 'xml', 'yaml', 'yml', 'toml', 'ini', 'log', 'csv', 'sql', 'py', 'go', 'rs', 'java', 'sh'].includes(extension)) return 'text'
  return 'unknown'
}

export function PreviewPanel({ item, onClose }: { item: S3Object; onClose: () => void }) {
  const [meta, setMeta] = useState<ObjectMeta | null>(null)
  const [text, setText] = useState('')
  const [pdfData, setPdfData] = useState<Uint8Array<ArrayBuffer> | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const kind = previewKind(item, meta)

  useEffect(() => {
    let current = true
    setLoading(true)
    setError('')
    setPdfData(null)
    getObjectMeta(item.key).then(async (value) => {
      if (!current) return
      setMeta(value)
      if (previewKind(item, value) === 'text') setText(await getTextPreview(item.key))
      if (previewKind(item, value) === 'pdf') setPdfData(await getBinaryPreview(item.key))
    }).catch((caught) => current && setError(caught instanceof Error ? caught.message : 'Ошибка предпросмотра'))
      .finally(() => current && setLoading(false))
    return () => { current = false }
  }, [item])

  return (
    <aside className="preview-panel">
      <header className="preview-header">
        <div className="preview-title-icon">{kind === 'image' ? <ImageIcon size={18} /> : kind === 'text' ? <Braces size={18} /> : <File size={18} />}</div>
        <div><strong title={item.name}>{item.name}</strong><span>Предпросмотр</span></div>
        <button className="icon-button" onClick={onClose}><X size={19} /></button>
      </header>

      <div className={`preview-stage preview-${kind}`}>
        {loading && <div className="preview-state"><LoaderCircle className="spin" /><span>Открываем файл…</span></div>}
        {!loading && error && <div className="preview-state"><Info /><span>{error}</span></div>}
        {!loading && !error && kind === 'image' && <img src={contentUrl(item.key)} alt={item.name} />}
        {!loading && !error && kind === 'pdf' && pdfData && (
          <Suspense fallback={<div className="preview-state"><LoaderCircle className="spin" /><span>Готовим просмотрщик…</span></div>}>
            <PdfPreview data={pdfData} fileName={item.name} />
          </Suspense>
        )}
        {!loading && !error && kind === 'text' && <pre>{text}{meta && meta.size > 524288 ? '\n\n… показаны первые 512 КБ' : ''}</pre>}
        {!loading && !error && kind === 'unknown' && <div className="unknown-preview"><FileText size={50} strokeWidth={1.25} /><strong>Нет быстрого просмотра</strong><span>Файл можно скачать и открыть в подходящем приложении.</span></div>}
      </div>

      <div className="preview-meta">
        <div><span>Размер</span><strong>{formatBytes(meta?.size ?? item.size)}</strong></div>
        <div><span>Тип</span><strong>{meta?.contentType || '—'}</strong></div>
        <div><span>Изменён</span><strong>{meta?.lastModified ? new Intl.DateTimeFormat('ru', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(meta.lastModified)) : '—'}</strong></div>
      </div>
      <a className="primary-button preview-download" href={contentUrl(item.key, true)}><Download size={17} /> Скачать файл</a>
    </aside>
  )
}
