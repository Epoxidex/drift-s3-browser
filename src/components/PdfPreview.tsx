import { useEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, LoaderCircle, ZoomIn, ZoomOut } from 'lucide-react'
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy, type RenderTask } from 'pdfjs-dist'
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

GlobalWorkerOptions.workerSrc = pdfWorkerUrl

type Props = {
  data: Uint8Array<ArrayBuffer>
  fileName: string
}

export function PdfPreview({ data, fileName }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null)
  const [pageNumber, setPageNumber] = useState(1)
  const [scale, setScale] = useState(1)
  const [loading, setLoading] = useState(true)
  const [rendering, setRendering] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    setLoading(true)
    setError('')
    setPageNumber(1)

    // PDF.js transfers the buffer to its worker, so give it a copy that is safe under React StrictMode.
    const loadingTask = getDocument({ data: data.slice() })
    loadingTask.promise.then((pdf) => {
      if (active) setDocument(pdf)
    }).catch(() => active && setError('Не удалось разобрать PDF-файл'))
      .finally(() => active && setLoading(false))

    return () => {
      active = false
      setDocument(null)
      void loadingTask.destroy()
    }
  }, [data])

  useEffect(() => {
    if (!document || !canvasRef.current) return
    let active = true
    let renderTask: RenderTask | undefined
    setRendering(true)
    setError('')

    document.getPage(pageNumber).then((page) => {
      if (!active || !canvasRef.current) return
      const pixelRatio = Math.min(window.devicePixelRatio || 1, 2)
      const viewport = page.getViewport({ scale: 1.45 * scale * pixelRatio })
      const canvas = canvasRef.current
      const context = canvas.getContext('2d')
      if (!context) throw new Error('Canvas недоступен')

      canvas.width = Math.floor(viewport.width)
      canvas.height = Math.floor(viewport.height)
      canvas.style.width = `${scale * 100}%`
      canvas.style.height = 'auto'
      renderTask = page.render({ canvas, canvasContext: context, viewport })
      return renderTask.promise
    }).catch((caught: unknown) => {
      if (active && (!(caught instanceof Error) || caught.name !== 'RenderingCancelledException')) {
        setError('Не удалось отрисовать страницу PDF')
      }
    }).finally(() => active && setRendering(false))

    return () => {
      active = false
      renderTask?.cancel()
    }
  }, [document, pageNumber, scale])

  const pages = document?.numPages ?? 0

  return (
    <div className="pdf-preview" data-testid="pdf-preview">
      <div className="pdf-toolbar">
        <div className="pdf-page-controls">
          <button disabled={pageNumber <= 1} onClick={() => setPageNumber((value) => value - 1)} aria-label="Предыдущая страница"><ChevronLeft size={16} /></button>
          <span><strong>{pageNumber}</strong> / {pages || '—'}</span>
          <button disabled={!pages || pageNumber >= pages} onClick={() => setPageNumber((value) => value + 1)} aria-label="Следующая страница"><ChevronRight size={16} /></button>
        </div>
        <div className="pdf-zoom-controls">
          <button disabled={scale <= .75} onClick={() => setScale((value) => Math.max(.75, value - .25))} aria-label="Уменьшить"><ZoomOut size={16} /></button>
          <span>{Math.round(scale * 100)}%</span>
          <button disabled={scale >= 2} onClick={() => setScale((value) => Math.min(2, value + .25))} aria-label="Увеличить"><ZoomIn size={16} /></button>
        </div>
      </div>
      <div className="pdf-canvas-scroll" aria-label={`PDF ${fileName}`}>
        {(loading || rendering) && <div className="pdf-loading"><LoaderCircle className="spin" size={20} /><span>{loading ? 'Читаем PDF…' : 'Рисуем страницу…'}</span></div>}
        {error && <div className="pdf-error">{error}</div>}
        <canvas ref={canvasRef} aria-label={`Страница ${pageNumber} из ${pages}`} />
      </div>
    </div>
  )
}
