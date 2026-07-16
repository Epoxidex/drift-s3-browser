import { useEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent } from 'react'
import {
  ArrowDownAZ, ArrowLeft, ArrowRight, ChevronDown, ChevronRight, Cloud, Database, Download, File, FileArchive,
  FileCode2, FileImage, FileText, Folder, FolderInput, FolderPlus, FolderUp, HardDrive, LayoutList, LoaderCircle,
  LogOut, MoreHorizontal, Move, PackageOpen, RefreshCw, Scissors, Search, Trash2, Upload, X, Copy, ClipboardPaste,
} from 'lucide-react'
import { archiveUrl, contentUrl, copyObject, createFolder, deleteObject, listObjects, moveObject, uploadFile, type TransferProgress } from '../api'
import type { Connection, S3Object } from '../types'
import { Modal } from './Modal'
import { PreviewPanel } from './PreviewPanel'

type Props = { connection: Connection; onDisconnect: () => void }
type Sort = 'name' | 'size' | 'date'
type UploadEntry = { file: File; relativePath: string }
type ClipboardState = { items: S3Object[]; operation: 'copy' | 'cut' }
type ContextMenuState = { item: S3Object; x: number; y: number }
type OperationProgress = { label: string; completed: number; total: number }

interface FileSystemEntryLike {
  isFile: boolean
  isDirectory: boolean
  name: string
  file?: (callback: (file: File) => void, error?: (reason: unknown) => void) => void
  createReader?: () => { readEntries: (callback: (entries: FileSystemEntryLike[]) => void, error?: (reason: unknown) => void) => void }
}

async function entryFiles(entry: FileSystemEntryLike, parent = ''): Promise<UploadEntry[]> {
  const path = `${parent}${entry.name}`
  if (entry.isFile && entry.file) {
    const file = await new Promise<File>((resolve, reject) => entry.file?.(resolve, reject))
    return [{ file, relativePath: path }]
  }
  if (!entry.isDirectory || !entry.createReader) return []
  const reader = entry.createReader()
  const children: FileSystemEntryLike[] = []
  while (true) {
    const page = await new Promise<FileSystemEntryLike[]>((resolve, reject) => reader.readEntries(resolve, reject))
    if (!page.length) break
    children.push(...page)
  }
  return (await Promise.all(children.map((child) => entryFiles(child, `${path}/`)))).flat()
}

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
  const [operationProgress, setOperationProgress] = useState<OperationProgress | null>(null)
  const [dragActive, setDragActive] = useState(false)
  const [clipboard, setClipboard] = useState<ClipboardState | null>(null)
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(() => new Set())
  const [deleteItems, setDeleteItems] = useState<S3Object[]>([])
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const folderInput = useRef<HTMLInputElement>(null)
  const toastTimer = useRef<number | null>(null)
  const selectAllInput = useRef<HTMLInputElement>(null)

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

  useEffect(() => {
    folderInput.current?.setAttribute('webkitdirectory', '')
  }, [])

  useEffect(() => () => {
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current)
  }, [])

  useEffect(() => {
    if (!contextMenu) return
    const close = () => setContextMenu(null)
    const closeOnEscape = (event: KeyboardEvent) => event.key === 'Escape' && close()
    window.addEventListener('pointerdown', close)
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      window.removeEventListener('pointerdown', close)
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [contextMenu])

  function showToast(message: string) {
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current)
    setToast(message)
    toastTimer.current = window.setTimeout(() => {
      setToast('')
      toastTimer.current = null
    }, 3500)
  }

  function openPrefix(value: string) {
    setPrefix(value)
    setTokens([null])
    setSearch('')
    setPreview(null)
    setSelectedKeys(new Set())
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

  const selectedItems = useMemo(() => items.filter((item) => selectedKeys.has(item.key)), [items, selectedKeys])
  const allVisibleSelected = visibleItems.length > 0 && visibleItems.every((item) => selectedKeys.has(item.key))

  useEffect(() => {
    if (selectAllInput.current) selectAllInput.current.indeterminate = selectedItems.length > 0 && !allVisibleSelected
  }, [allVisibleSelected, selectedItems.length])

  const crumbs = useMemo(() => {
    const parts = prefix.split('/').filter(Boolean)
    return parts.map((name, index) => ({ name, prefix: `${parts.slice(0, index + 1).join('/')}/` }))
  }, [prefix])

  async function doUpload(files: FileList | File[] | UploadEntry[]) {
    const list: UploadEntry[] = Array.from(files as ArrayLike<File | UploadEntry>).map((value) => {
      if ('relativePath' in value) return value
      return { file: value, relativePath: value.webkitRelativePath || value.name }
    })
    if (!list.length) return
    setBusy(true)
    setOperationProgress({ label: 'Загрузка файлов', completed: 0, total: list.length })
    try {
      let completed = 0
      let cursor = 0
      const workers = Array.from({ length: Math.min(4, list.length) }, async () => {
        while (cursor < list.length) {
          const index = cursor++
          const entry = list[index]
          await uploadFile(prefix, entry.file, entry.relativePath)
          completed += 1
          setOperationProgress({ label: 'Загрузка файлов', completed, total: list.length })
        }
      })
      const results = await Promise.allSettled(workers)
      const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
      if (failed) throw failed.reason
      showToast(list.length === 1 ? 'Файл загружен' : `Загружено файлов: ${list.length}`)
      setRefresh((value) => value + 1)
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Ошибка загрузки')
    } finally {
      setOperationProgress(null)
      setBusy(false)
      if (fileInput.current) fileInput.current.value = ''
      if (folderInput.current) folderInput.current.value = ''
    }
  }

  async function onDrop(event: DragEvent) {
    event.preventDefault()
    setDragActive(false)
    const entries = Array.from(event.dataTransfer.items)
      .map((item) => (item as DataTransferItem & { webkitGetAsEntry?: () => FileSystemEntryLike | null }).webkitGetAsEntry?.() as FileSystemEntryLike | null | undefined)
      .filter(Boolean) as FileSystemEntryLike[]
    if (entries.length) {
      try {
        const files = (await Promise.all(entries.map((entry) => entryFiles(entry)))).flat()
        await doUpload(files)
        return
      } catch {
        // The browser can deny directory traversal; the regular file list remains usable.
      }
    }
    await doUpload(event.dataTransfer.files)
  }

  function showContextMenu(event: MouseEvent, item: S3Object) {
    event.preventDefault()
    event.stopPropagation()
    if (!selectedKeys.has(item.key)) setSelectedKeys(new Set([item.key]))
    setContextMenu({ item, x: Math.min(event.clientX, window.innerWidth - 220), y: Math.min(event.clientY, window.innerHeight - 300) })
  }

  function toggleSelection(item: S3Object, checked: boolean) {
    setSelectedKeys((current) => {
      const next = new Set(current)
      if (checked) next.add(item.key)
      else next.delete(item.key)
      return next
    })
  }

  function toggleAllVisible(checked: boolean) {
    setSelectedKeys((current) => {
      const next = new Set(current)
      visibleItems.forEach((item) => checked ? next.add(item.key) : next.delete(item.key))
      return next
    })
  }

  function actionItems(item: S3Object) {
    return selectedKeys.has(item.key) ? selectedItems : [item]
  }

  function putOnClipboard(itemsToStore: S3Object[], operation: 'copy' | 'cut') {
    if (!itemsToStore.length) return
    setClipboard({ items: itemsToStore, operation })
    setContextMenu(null)
    showToast(itemsToStore.length === 1
      ? `${operation === 'copy' ? 'Скопировано' : 'Вырезано'}: ${itemsToStore[0].name}`
      : `${operation === 'copy' ? 'Скопировано' : 'Вырезано'} объектов: ${itemsToStore.length}`)
  }

  async function pasteClipboard() {
    if (!clipboard) return
    const transfers = clipboard.items.map((item) => {
      const bareKey = item.key.replace(/\/$/, '')
      const name = bareKey.split('/').pop() || item.name
      return { item, targetKey: `${prefix}${name}${item.type === 'folder' ? '/' : ''}` }
    })
    if (transfers.some(({ item, targetKey }) => targetKey === item.key)) {
      showToast('Источник уже находится в этой папке')
      return
    }
    setBusy(true)
    setOperationProgress({ label: clipboard.operation === 'copy' ? 'Подготовка к копированию' : 'Подготовка к переносу', completed: 0, total: 1 })
    let completedTransfers = 0
    try {
      for (let index = 0; index < transfers.length; index += 1) {
        const { item, targetKey } = transfers[index]
        const itemPosition = transfers.length > 1 ? ` (${index + 1} из ${transfers.length})` : ''
        const updateProgress = (progress: TransferProgress) => setOperationProgress({
          label: `${progress.phase === 'copying' ? 'Копирование' : 'Удаление исходников'} «${item.name}»${itemPosition}`,
          completed: progress.completed,
          total: progress.total,
        })
        if (clipboard.operation === 'copy') await copyObject(item, targetKey, updateProgress)
        else await moveObject(item, targetKey, updateProgress)
        completedTransfers += 1
      }
      showToast(clipboard.items.length === 1
        ? (clipboard.operation === 'copy' ? 'Объект скопирован' : 'Объект перемещён')
        : `${clipboard.operation === 'copy' ? 'Скопировано' : 'Перемещено'} объектов: ${clipboard.items.length}`)
      if (clipboard.operation === 'cut') setClipboard(null)
      setSelectedKeys(new Set())
      setRefresh((value) => value + 1)
    } catch (error) {
      if (clipboard.operation === 'cut' && completedTransfers > 0) setClipboard({ ...clipboard, items: clipboard.items.slice(completedTransfers) })
      if (completedTransfers > 0) setRefresh((value) => value + 1)
      showToast(error instanceof Error ? error.message : 'Не удалось вставить объект')
    } finally {
      setOperationProgress(null)
      setBusy(false)
    }
  }

  function openMove(item: S3Object) {
    setActiveItem(item)
    setInputValue(item.key.replace(/\/$/, ''))
    setDialog('move')
  }

  function openDelete(itemsToDelete: S3Object[]) {
    setDeleteItems(itemsToDelete)
    setDialog('delete')
  }

  async function submitDialog() {
    setBusy(true)
    const deletedKeys = new Set<string>()
    try {
      if (dialog === 'folder') {
        const name = cleanName(inputValue)
        if (!name) throw new Error('Введите название папки')
        await createFolder(`${prefix}${name}/`)
        showToast('Папка создана')
      } else if (dialog === 'move' && activeItem) {
        const target = inputValue.trim()
        if (!target) throw new Error('Введите новый путь')
        setOperationProgress({ label: 'Подготовка к переносу', completed: 0, total: 1 })
        await moveObject(activeItem, target, (progress) => setOperationProgress({
          label: progress.phase === 'copying' ? `Копирование «${activeItem.name}»` : `Удаление исходников «${activeItem.name}»`,
          completed: progress.completed,
          total: progress.total,
        }))
        if (preview?.key === activeItem.key) setPreview(null)
        showToast('Объект перемещён')
      } else if (dialog === 'delete' && deleteItems.length) {
        setOperationProgress({ label: 'Удаление объектов', completed: 0, total: deleteItems.length })
        for (let index = 0; index < deleteItems.length; index += 1) {
          await deleteObject(deleteItems[index])
          deletedKeys.add(deleteItems[index].key)
          setOperationProgress({ label: 'Удаление объектов', completed: index + 1, total: deleteItems.length })
        }
        if (preview && deleteItems.some((item) => item.key === preview.key)) setPreview(null)
        showToast(deleteItems.length === 1
          ? (deleteItems[0].type === 'folder' ? 'Папка удалена' : 'Файл удалён')
          : `Удалено объектов: ${deleteItems.length}`)
        setSelectedKeys(new Set())
      }
      setDialog(null)
      setRefresh((value) => value + 1)
    } catch (error) {
      if (deletedKeys.size) {
        setDeleteItems((current) => current.filter((item) => !deletedKeys.has(item.key)))
        setSelectedKeys((current) => new Set([...current].filter((key) => !deletedKeys.has(key))))
        setRefresh((value) => value + 1)
      }
      showToast(error instanceof Error ? error.message : 'Операция не выполнена')
    } finally {
      setOperationProgress(null)
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
          <button onClick={() => folderInput.current?.click()}><FolderUp size={17} /> Загрузить папку</button>
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
            <button className="secondary-button paste-button" disabled={!clipboard || busy} onClick={() => void pasteClipboard()} title={clipboard ? `${clipboard.operation === 'copy' ? 'Копировать' : 'Переместить'} сюда: ${clipboard.items.length}` : 'Сначала скопируйте или вырежьте объекты'}><ClipboardPaste size={17} /> Вставить{clipboard && clipboard.items.length > 1 ? ` (${clipboard.items.length})` : ''}</button>
            <button className="secondary-button" onClick={() => { setInputValue(''); setDialog('folder') }}><FolderPlus size={17} /> Новая папка</button>
            <button className="secondary-button folder-upload-button" disabled={busy} onClick={() => folderInput.current?.click()}><FolderUp size={17} /> Папку</button>
            <button className="primary-button" disabled={busy} onClick={() => fileInput.current?.click()}><Upload size={17} /> Загрузить</button>
            <input ref={fileInput} type="file" multiple hidden onChange={(e) => e.target.files && void doUpload(e.target.files)} />
            <input ref={folderInput} type="file" multiple hidden onChange={(e) => e.target.files && void doUpload(e.target.files)} />
          </div>
        </header>

        <section className="browser-content">
          <div className="content-heading">
            <div><span className="eyebrow">Объекты</span><h1>{prefix ? crumbs.at(-1)?.name : 'Все файлы'}</h1><p>{loading ? 'Читаем содержимое…' : `${items.length} на этой странице`}</p></div>
            <button className="icon-button" onClick={() => setRefresh((value) => value + 1)} title="Обновить"><RefreshCw className={loading ? 'spin' : ''} size={18} /></button>
          </div>

          <div className="object-toolbar">
            <label className="search-box"><Search size={17} /><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Найти на странице" />{search && <button onClick={() => setSearch('')}><X size={15} /></button>}</label>
            <div className="toolbar-actions">
              {selectedItems.length > 0 && <><span className="selection-count">Выбрано: {selectedItems.length}</span><button disabled={busy} onClick={() => putOnClipboard(selectedItems, 'copy')}><Copy size={15} />Копировать</button><button disabled={busy} onClick={() => putOnClipboard(selectedItems, 'cut')}><Scissors size={15} />Вырезать</button><button className="danger" disabled={busy} onClick={() => openDelete(selectedItems)}><Trash2 size={15} />Удалить</button></>}
              <div className="toolbar-view"><LayoutList size={17} /><span>Список</span></div>
            </div>
          </div>

          <div className="object-table">
            <div className="object-table-head">
              <div className="object-name-head"><label className="selection-checkbox" title="Выбрать всё на странице"><input ref={selectAllInput} type="checkbox" aria-label="Выбрать всё на странице" checked={allVisibleSelected} onChange={(event) => toggleAllVisible(event.target.checked)} /><span /></label><button onClick={() => changeSort('name')}>Название {sort === 'name' && <ArrowDownAZ className={!sortAsc ? 'flip-y' : ''} size={15} />}</button></div>
              <button onClick={() => changeSort('size')}>Размер</button>
              <button onClick={() => changeSort('date')}>Изменён</button>
              <span />
            </div>
            <div className="object-table-body">
              {loading && <div className="table-state"><LoaderCircle className="spin" /><span>Загружаем объекты…</span></div>}
              {!loading && visibleItems.length === 0 && <div className="table-state empty"><PackageOpen size={38} strokeWidth={1.3} /><strong>{search ? 'Ничего не найдено' : 'Здесь пока пусто'}</strong><span>{search ? 'Попробуйте изменить запрос' : 'Перетащите файлы сюда или создайте папку'}</span></div>}
              {!loading && visibleItems.map((item) => (
                <div key={item.key} className={`object-row ${preview?.key === item.key || selectedKeys.has(item.key) ? 'selected' : ''} ${clipboard?.items.some((clipboardItem) => clipboardItem.key === item.key) ? `clipboard-${clipboard.operation}` : ''}`} onContextMenu={(event) => showContextMenu(event, item)} onDoubleClick={() => item.type === 'folder' ? openPrefix(item.key) : setPreview(item)}>
                  <div className="object-name-cell">
                    <label className="selection-checkbox" title={`Выбрать ${item.name}`} onClick={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()}><input type="checkbox" aria-label={`Выбрать ${item.name}`} checked={selectedKeys.has(item.key)} onChange={(event) => toggleSelection(item, event.target.checked)} /><span /></label>
                    <button className="object-name" onClick={() => item.type === 'folder' ? openPrefix(item.key) : setPreview(item)}>
                      <span className={`file-icon ${item.type}`}>{fileIcon(item)}</span><span><strong>{item.name}</strong><small>{item.type === 'folder' ? 'Папка' : item.name.split('.').pop()?.toUpperCase() || 'Файл'}</small></span>
                    </button>
                  </div>
                  <span className="object-size">{item.type === 'folder' ? '—' : formatBytes(item.size)}</span>
                  <span className="object-date">{item.lastModified ? new Intl.DateTimeFormat('ru', { day: '2-digit', month: 'short', year: 'numeric' }).format(new Date(item.lastModified)) : '—'}</span>
                  <div className="row-actions">
                    <button className="more-button" onClick={(event) => showContextMenu(event, item)} title="Действия"><MoreHorizontal size={17} /></button>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <footer className="pagination">
            <label>Показывать <select value={pageSize} onChange={(e) => { setPageSize(Number(e.target.value)); setTokens([null]); setSelectedKeys(new Set()) }}><option>25</option><option>50</option><option>100</option><option>200</option></select><ChevronDown size={14} /></label>
            <span>Страница {tokens.length}</span>
            <div><button disabled={tokens.length === 1 || loading} onClick={() => { setSelectedKeys(new Set()); setTokens((value) => value.slice(0, -1)) }}><ArrowLeft size={16} /></button><button disabled={!nextToken || loading} onClick={() => { if (nextToken) { setSelectedKeys(new Set()); setTokens((value) => [...value, nextToken]) } }}><ArrowRight size={16} /></button></div>
          </footer>
        </section>
      </main>

      {preview && <PreviewPanel item={preview} onClose={() => setPreview(null)} />}
      {contextMenu && (
        <div className="context-menu" style={{ left: contextMenu.x, top: contextMenu.y }} onPointerDown={(event) => event.stopPropagation()}>
          <button onClick={() => { contextMenu.item.type === 'folder' ? openPrefix(contextMenu.item.key) : setPreview(contextMenu.item); setContextMenu(null) }}><FolderInput size={16} />{contextMenu.item.type === 'folder' ? 'Открыть' : 'Предпросмотр'}</button>
          <a href={contextMenu.item.type === 'folder' ? archiveUrl(contextMenu.item.key) : contentUrl(contextMenu.item.key, true)} onClick={() => setContextMenu(null)}><Download size={16} />{contextMenu.item.type === 'folder' ? 'Скачать ZIP' : 'Скачать'}</a>
          <div className="context-separator" />
          <button onClick={() => putOnClipboard(actionItems(contextMenu.item), 'copy')}><Copy size={16} />Копировать{actionItems(contextMenu.item).length > 1 ? ` (${actionItems(contextMenu.item).length})` : ''}</button>
          <button onClick={() => putOnClipboard(actionItems(contextMenu.item), 'cut')}><Scissors size={16} />Вырезать{actionItems(contextMenu.item).length > 1 ? ` (${actionItems(contextMenu.item).length})` : ''}</button>
          {actionItems(contextMenu.item).length === 1 && <button onClick={() => { openMove(contextMenu.item); setContextMenu(null) }}><Move size={16} />Переименовать / переместить</button>}
          <div className="context-separator" />
          <button className="danger" onClick={() => { openDelete(actionItems(contextMenu.item)); setContextMenu(null) }}><Trash2 size={16} />Удалить{actionItems(contextMenu.item).length > 1 ? ` (${actionItems(contextMenu.item).length})` : ''}</button>
        </div>
      )}
      {dragActive && <div className="drop-overlay" onDragLeave={() => setDragActive(false)}><div><Upload size={32} /><strong>Отпустите, чтобы загрузить</strong><span>Файлы попадут в текущую папку</span></div></div>}
      {operationProgress && (
        <div className="operation-progress" role="progressbar" aria-label={operationProgress.label} aria-valuemin={0} aria-valuemax={operationProgress.total} aria-valuenow={operationProgress.completed}>
          <LoaderCircle className="spin" size={17} />
          <div><strong>{operationProgress.label}</strong><span>Осталось: {operationProgress.total - operationProgress.completed}</span></div>
          <div className="operation-progress-track"><span style={{ width: `${operationProgress.total ? operationProgress.completed / operationProgress.total * 100 : 0}%` }} /></div>
        </div>
      )}
      {toast && <div className="toast">{busy && <LoaderCircle className="spin" size={16} />}{toast}</div>}

      {dialog === 'folder' && <Modal title="Новая папка" onClose={() => setDialog(null)}><div className="modal-body"><label><span>Название папки</span><input autoFocus value={inputValue} onChange={(e) => setInputValue(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void submitDialog()} placeholder="Например, документы" /></label><small>Будет создана в <strong>/{prefix}</strong></small></div><div className="modal-actions"><button className="secondary-button" onClick={() => setDialog(null)}>Отмена</button><button className="primary-button" disabled={busy} onClick={() => void submitDialog()}>Создать</button></div></Modal>}
      {dialog === 'move' && activeItem && <Modal title="Переместить или переименовать" onClose={() => setDialog(null)}><div className="modal-body"><label><span>Новый полный путь</span><input autoFocus value={inputValue} onChange={(e) => setInputValue(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void submitDialog()} /></label><small>Укажите путь от корня бакета. Для переименования измените последнюю часть.</small></div><div className="modal-actions"><button className="secondary-button" onClick={() => setDialog(null)}>Отмена</button><button className="primary-button" disabled={busy} onClick={() => void submitDialog()}>Переместить</button></div></Modal>}
      {dialog === 'delete' && deleteItems.length > 0 && <Modal title={deleteItems.length === 1 ? `Удалить ${deleteItems[0].type === 'folder' ? 'папку' : 'файл'}?` : `Удалить объекты (${deleteItems.length})?`} onClose={() => setDialog(null)}><div className="modal-body delete-copy"><div className="delete-icon"><Trash2 size={22} /></div><p><strong>{deleteItems.length === 1 ? deleteItems[0].name : `Выбрано объектов: ${deleteItems.length}`}</strong>{deleteItems.length === 1 ? (deleteItems[0].type === 'folder' ? ' и всё её содержимое будут удалены без возможности восстановления.' : ' будет удалён без возможности восстановления.') : 'Выбранные объекты и всё содержимое папок будут удалены без возможности восстановления.'}</p></div><div className="modal-actions"><button className="secondary-button" onClick={() => setDialog(null)}>Отмена</button><button className="danger-button" disabled={busy} onClick={() => void submitDialog()}>Удалить</button></div></Modal>}
    </div>
  )
}
