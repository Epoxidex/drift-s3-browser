import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import {
  ArrowDownAZ, ArrowLeft, ArrowRight, ChevronDown, ChevronRight, Cloud, Database, Download, File, FileArchive,
  FileCode2, FileImage, FileText, Folder, FolderPlus, HardDrive, LayoutList, LoaderCircle, LogOut, MoreHorizontal,
  Move, PackageOpen, Plus, RefreshCw, Search, Trash2, Upload, X,
} from 'lucide-react'
import { contentUrl, createFolder, deleteObject, listObjects, moveObject, uploadFile } from '../api'
import type { Connection, S3Object } from '../types'
import { Modal } from './Modal'
import { PreviewPanel } from './PreviewPanel'

type Props = { connection: Connection; onDisconnect: () => void }
type Sort = 'name' | 'size' | 'date'

function formatBytes(value: number) {
  if (!value) return '—'
  const units = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ']
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1)
  return `${new Intl.NumberFormat('ru', { maximumFractionDigits: 1 }).format(value / 1024 ** index)} ${units[index]}`
}

function fileIcon(item: S3Object) {
  if (item.type === 'folder') return <Folder size={21} fill="currentColor" strokeWidth={1.5} />
  const ext = item.name.split('.').pop()?.toLowerCase()
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg'].includes(ext || '')) return <FileImage size={20} />
  if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext || '')) return <FileArchive size={20} />
  if (['js', 'jsx', 'ts', 'tsx', 'json', 'py', 'go', 'rs', 'html', 'css'].includes(ext || '')) return <FileCode2 size={20} />
  if (['txt', 'md', 'pdf', 'doc', 'docx', 'csv'].includes(ext || '')) return <FileText size={20} />
  return <File size={20} />
}

function cleanName(name: string) {
  return name.replace(/[\\/]/g, '').trim()
}

export function Browser({ connection, onDisconnect }: Props) {
  const [prefix, setPrefix] = useState('')
  const [items, setItems] = useState<S3Object[]>([])
  const [nextToken, setNextToken] = useState<string | null>(null)
  const [tokens, setTokens] = useState<(string | null)[]>([null])
  const [pageSize, setPageSize] = useState(50)
  const [loading, setLoading] = useState(true)
  const [refresh, setRefresh] = useState(0)
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState<Sort>('name')
  const [sortAsc, setSortAsc] = useState(true)
  const [preview, setPreview] = useState<S3Object | null>(null)
  const [dialog, setDialog] = useState<'folder' | 'move' | 'delete' | null>(null)
  const [activeItem, setActiveItem] = useState<S3Object | null>(null)
  const [inputValue, setInputValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState('')
  const [dragActive, setDragActive] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)

  const currentToken = tokens[tokens.length - 1]

  useEffect(() => {
    let current = true
    setLoading(true)
    listObjects(prefix, currentToken, pageSize)
      .then((page) => { if (current) { setItems(page.items); setNextToken(page.nextToken) } })
      .catch((error) => current && showToast(error instanceof Error ? error.message : 'Не удалось прочитать бакет'))
      .finally(() => current && setLoading(false))
    return () => { current = false }
  }, [prefix, currentToken, pageSize, refresh])

  function showToast(message: string) {
    setToast(message)
    window.setTimeout(() => setToast(''), 3500)
  }

  function openPrefix(value: string) {
    setPrefix(value)
    setTokens([null])
    setSearch('')
    setPreview(null)
  }

  const visibleItems = useMemo(() => {
    const filtered = items.filter((item) => item.name.toLocaleLowerCase('ru').includes(search.toLocaleLowerCase('ru')))
    return filtered.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'folder' ? -1 : 1
      const direction = sortAsc ? 1 : -1
      if (sort === 'size') return (a.size - b.size) * direction
      if (sort === 'date') return ((a.lastModified || '').localeCompare(b.lastModified || '')) * direction
      return a.name.localeCompare(b.name, 'ru', { numeric: true }) * direction
    })
  }, [items, search, sort, sortAsc])

  const crumbs = useMemo(() => {
    const parts = prefix.split('/').filter(Boolean)
    return parts.map((name, index) => ({ name, prefix: `${parts.slice(0, index + 1).join('/')}/` }))
  }, [prefix])

  async function doUpload(files: FileList | File[]) {
    const list = Array.from(files)
    if (!list.length) return
    setBusy(true)
    try {
      for (let index = 0; index < list.length; index += 1) {
        showToast(`Загрузка ${index + 1} из ${list.length}: ${list[index].name}`)
        await uploadFile(prefix, list[index])
      }
      showToast(list.length === 1 ? 'Файл загружен' : `Загружено файлов: ${list.length}`)
      setRefresh((value) => value + 1)
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Ошибка загрузки')
    } finally {
      setBusy(false)
      if (fileInput.current) fileInput.current.value = ''
    }
  }

  function onDrop(event: DragEvent) {
    event.preventDefault()
    setDragActive(false)
    void doUpload(event.dataTransfer.files)
  }

  function openMove(item: S3Object) {
    setActiveItem(item)
    setInputValue(item.key.replace(/\/$/, ''))
    setDialog('move')
  }

  function openDelete(item: S3Object) {
    setActiveItem(item)
    setDialog('delete')
  }

  async function submitDialog() {
    setBusy(true)
    try {
      if (dialog === 'folder') {
        const name = cleanName(inputValue)
        if (!name) throw new Error('Введите название папки')
        await createFolder(`${prefix}${name}/`)
        showToast('Папка создана')
      } else if (dialog === 'move' && activeItem) {
        const target = inputValue.trim()
        if (!target) throw new Error('Введите новый путь')
        await moveObject(activeItem, target)
        if (preview?.key === activeItem.key) setPreview(null)
        showToast('Объект перемещён')
      } else if (dialog === 'delete' && activeItem) {
        await deleteObject(activeItem)
        if (preview?.key === activeItem.key) setPreview(null)
        showToast(activeItem.type === 'folder' ? 'Папка удалена' : 'Файл удалён')
      }
      setDialog(null)
      setRefresh((value) => value + 1)
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Операция не выполнена')
    } finally {
      setBusy(false)
    }
  }

  function changeSort(value: Sort) {
    if (sort === value) setSortAsc(!sortAsc)
    else { setSort(value); setSortAsc(true) }
  }

  return (
    <div className="app-shell" onDragEnter={() => setDragActive(true)} onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
      <aside className="sidebar">
        <div className="sidebar-brand"><div className="brand-mark"><Database size={19} /></div><span>Drift</span></div>
        <div className="sidebar-section-label">Хранилище</div>
        <button className="bucket-card" onClick={() => openPrefix('')}>
          <span className="bucket-icon"><Cloud size={20} /></span>
          <span><strong>{connection.name}</strong><small>{connection.region}</small></span>
          <ChevronRight size={16} />
        </button>
        <nav className="sidebar-nav">
          <button className={!prefix ? 'active' : ''} onClick={() => openPrefix('')}><HardDrive size={17} /> Все файлы</button>
          <button onClick={() => fileInput.current?.click()}><Upload size={17} /> Загрузить</button>
        </nav>
        <div className="sidebar-spacer" />
        <div className="endpoint-note"><span>S3 endpoint</span><strong title={connection.endpoint}>{new URL(connection.endpoint).host}</strong><small>{connection.bucket}</small></div>
        <button className="sidebar-exit" onClick={onDisconnect}><LogOut size={17} /> Сменить подключение</button>
      </aside>

      <main className={`browser-main ${preview ? 'with-preview' : ''}`}>
        <header className="browser-topbar">
          <div className="breadcrumbs">
            <button onClick={() => openPrefix('')}><PackageOpen size={18} /></button>
            <ChevronRight size={15} />
            <button className={!prefix ? 'current' : ''} onClick={() => openPrefix('')}>{connection.bucket}</button>
            {crumbs.map((crumb, index) => <span key={crumb.prefix}><ChevronRight size={15} /><button className={index === crumbs.length - 1 ? 'current' : ''} onClick={() => openPrefix(crumb.prefix)}>{crumb.name}</button></span>)}
          </div>
          <div className="top-actions">
            <button className="secondary-button" onClick={() => { setInputValue(''); setDialog('folder') }}><FolderPlus size={17} /> Новая папка</button>
            <button className="primary-button" disabled={busy} onClick={() => fileInput.current?.click()}><Upload size={17} /> Загрузить</button>
            <input ref={fileInput} type="file" multiple hidden onChange={(e) => e.target.files && void doUpload(e.target.files)} />
          </div>
        </header>

        <section className="browser-content">
          <div className="content-heading">
            <div><span className="eyebrow">Объекты</span><h1>{prefix ? crumbs.at(-1)?.name : 'Все файлы'}</h1><p>{loading ? 'Читаем содержимое…' : `${items.length} на этой странице`}</p></div>
            <button className="icon-button" onClick={() => setRefresh((value) => value + 1)} title="Обновить"><RefreshCw className={loading ? 'spin' : ''} size={18} /></button>
          </div>

          <div className="object-toolbar">
            <label className="search-box"><Search size={17} /><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Найти на странице" />{search && <button onClick={() => setSearch('')}><X size={15} /></button>}</label>
            <div className="toolbar-view"><LayoutList size={17} /><span>Список</span></div>
          </div>

          <div className="object-table">
            <div className="object-table-head">
              <button onClick={() => changeSort('name')}>Название {sort === 'name' && <ArrowDownAZ className={!sortAsc ? 'flip-y' : ''} size={15} />}</button>
              <button onClick={() => changeSort('size')}>Размер</button>
              <button onClick={() => changeSort('date')}>Изменён</button>
              <span />
            </div>
            <div className="object-table-body">
              {loading && <div className="table-state"><LoaderCircle className="spin" /><span>Загружаем объекты…</span></div>}
              {!loading && visibleItems.length === 0 && <div className="table-state empty"><PackageOpen size={38} strokeWidth={1.3} /><strong>{search ? 'Ничего не найдено' : 'Здесь пока пусто'}</strong><span>{search ? 'Попробуйте изменить запрос' : 'Перетащите файлы сюда или создайте папку'}</span></div>}
              {!loading && visibleItems.map((item) => (
                <div key={item.key} className={`object-row ${preview?.key === item.key ? 'selected' : ''}`} onDoubleClick={() => item.type === 'folder' ? openPrefix(item.key) : setPreview(item)}>
                  <button className="object-name" onClick={() => item.type === 'folder' ? openPrefix(item.key) : setPreview(item)}>
                    <span className={`file-icon ${item.type}`}>{fileIcon(item)}</span><span><strong>{item.name}</strong><small>{item.type === 'folder' ? 'Папка' : item.name.split('.').pop()?.toUpperCase() || 'Файл'}</small></span>
                  </button>
                  <span className="object-size">{item.type === 'folder' ? '—' : formatBytes(item.size)}</span>
                  <span className="object-date">{item.lastModified ? new Intl.DateTimeFormat('ru', { day: '2-digit', month: 'short', year: 'numeric' }).format(new Date(item.lastModified)) : '—'}</span>
                  <div className="row-actions">
                    {item.type === 'file' && <a href={contentUrl(item.key, true)} title="Скачать"><Download size={16} /></a>}
                    <button onClick={() => openMove(item)} title="Переместить или переименовать"><Move size={16} /></button>
                    <button className="danger" onClick={() => openDelete(item)} title="Удалить"><Trash2 size={16} /></button>
                    <MoreHorizontal className="more-placeholder" size={17} />
                  </div>
                </div>
              ))}
            </div>
          </div>

          <footer className="pagination">
            <label>Показывать <select value={pageSize} onChange={(e) => { setPageSize(Number(e.target.value)); setTokens([null]) }}><option>25</option><option>50</option><option>100</option><option>200</option></select><ChevronDown size={14} /></label>
            <span>Страница {tokens.length}</span>
            <div><button disabled={tokens.length === 1 || loading} onClick={() => setTokens((value) => value.slice(0, -1))}><ArrowLeft size={16} /></button><button disabled={!nextToken || loading} onClick={() => nextToken && setTokens((value) => [...value, nextToken])}><ArrowRight size={16} /></button></div>
          </footer>
        </section>
      </main>

      {preview && <PreviewPanel item={preview} onClose={() => setPreview(null)} />}
      {dragActive && <div className="drop-overlay" onDragLeave={() => setDragActive(false)}><div><Upload size={32} /><strong>Отпустите, чтобы загрузить</strong><span>Файлы попадут в текущую папку</span></div></div>}
      {toast && <div className="toast">{busy && <LoaderCircle className="spin" size={16} />}{toast}</div>}

      {dialog === 'folder' && <Modal title="Новая папка" onClose={() => setDialog(null)}><div className="modal-body"><label><span>Название папки</span><input autoFocus value={inputValue} onChange={(e) => setInputValue(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void submitDialog()} placeholder="Например, документы" /></label><small>Будет создана в <strong>/{prefix}</strong></small></div><div className="modal-actions"><button className="secondary-button" onClick={() => setDialog(null)}>Отмена</button><button className="primary-button" disabled={busy} onClick={() => void submitDialog()}>Создать</button></div></Modal>}
      {dialog === 'move' && activeItem && <Modal title="Переместить или переименовать" onClose={() => setDialog(null)}><div className="modal-body"><label><span>Новый полный путь</span><input autoFocus value={inputValue} onChange={(e) => setInputValue(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void submitDialog()} /></label><small>Укажите путь от корня бакета. Для переименования измените последнюю часть.</small></div><div className="modal-actions"><button className="secondary-button" onClick={() => setDialog(null)}>Отмена</button><button className="primary-button" disabled={busy} onClick={() => void submitDialog()}>Переместить</button></div></Modal>}
      {dialog === 'delete' && activeItem && <Modal title={`Удалить ${activeItem.type === 'folder' ? 'папку' : 'файл'}?`} onClose={() => setDialog(null)}><div className="modal-body delete-copy"><div className="delete-icon"><Trash2 size={22} /></div><p><strong>{activeItem.name}</strong>{activeItem.type === 'folder' ? ' и всё её содержимое будут удалены без возможности восстановления.' : ' будет удалён без возможности восстановления.'}</p></div><div className="modal-actions"><button className="secondary-button" onClick={() => setDialog(null)}>Отмена</button><button className="danger-button" disabled={busy} onClick={() => void submitDialog()}>Удалить</button></div></Modal>}
    </div>
  )
}
