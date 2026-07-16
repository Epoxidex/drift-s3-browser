import type { Connection, ObjectMeta, ObjectPage, S3Object } from './types'

let connectionId = sessionStorage.getItem('s3-connection-id') || ''

export class ApiError extends Error {
  status: number

  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

export type TransferProgress = {
  phase: 'copying' | 'deleting'
  completed: number
  total: number
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers)
  if (connectionId) headers.set('x-s3-connection', connectionId)
  if (options.body && !(options.body instanceof FormData)) headers.set('content-type', 'application/json')

  let response: Response
  try {
    response = await fetch(path, { ...options, headers })
  } catch {
    throw new ApiError('API-сервер недоступен. Убедитесь, что npm run dev запустил процессы [api] и [web].', 0)
  }
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string } | null
    throw new ApiError(body?.error || `Ошибка запроса (${response.status})`, response.status)
  }
  if (response.status === 204) return undefined as T
  return response.json() as Promise<T>
}

export function setActiveConnection(id: string) {
  connectionId = id
  sessionStorage.setItem('s3-connection-id', id)
  return request<void>(`/api/connections/${id}/activate`, { method: 'POST' })
}

export function clearActiveConnection() {
  connectionId = ''
  sessionStorage.removeItem('s3-connection-id')
}

export async function getConnections() {
  const result = await request<{ connections: Connection[] }>('/api/connections')
  return result.connections
}

export async function createConnection(values: Record<string, unknown>) {
  const result = await request<{ connection: Connection }>('/api/connections', { method: 'POST', body: JSON.stringify(values) })
  return result.connection
}

export function listObjects(prefix: string, token: string | null, pageSize: number) {
  const params = new URLSearchParams({ prefix, pageSize: String(pageSize) })
  if (token) params.set('token', token)
  return request<ObjectPage>(`/api/objects?${params}`)
}

export function getObjectMeta(key: string) {
  return request<ObjectMeta>(`/api/objects/meta?${new URLSearchParams({ key })}`)
}

export function contentUrl(key: string, download = false) {
  const params = new URLSearchParams({ key })
  if (download) params.set('download', '1')
  return `/api/objects/content?${params}`
}

export function archiveUrl(prefix: string) {
  return `/api/objects/archive?${new URLSearchParams({ prefix })}`
}

export async function getTextPreview(key: string) {
  const response = await fetch(contentUrl(key), {
    headers: { 'x-s3-connection': connectionId, range: 'bytes=0-524287' },
  })
  if (!response.ok) throw new ApiError('Не удалось прочитать файл', response.status)
  return response.text()
}

export async function getBinaryPreview(key: string) {
  let response: Response
  try {
    response = await fetch(contentUrl(key), { headers: { 'x-s3-connection': connectionId } })
  } catch {
    throw new ApiError('Не удалось загрузить файл для предпросмотра', 0)
  }
  if (!response.ok) throw new ApiError('Не удалось загрузить файл для предпросмотра', response.status)
  return new Uint8Array(await response.arrayBuffer())
}

export function createFolder(key: string) {
  return request<{ key: string }>('/api/objects/folder', { method: 'POST', body: JSON.stringify({ key }) })
}

export function uploadFile(prefix: string, file: File, relativePath = file.name) {
  const form = new FormData()
  form.append('file', file)
  return request<{ key: string }>(`/api/objects/upload?${new URLSearchParams({ prefix, relativePath })}`, { method: 'POST', body: form })
}

async function transferObject(path: '/api/objects/copy' | '/api/objects/move', item: S3Object, targetKey: string, onProgress?: (progress: TransferProgress) => void) {
  let response: Response
  try {
    response = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-s3-connection': connectionId },
      body: JSON.stringify({ sourceKey: item.key, targetKey, type: item.type }),
    })
  } catch {
    throw new ApiError('API-сервер недоступен. Убедитесь, что npm run dev запустил процессы [api] и [web].', 0)
  }
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string } | null
    throw new ApiError(body?.error || `Ошибка запроса (${response.status})`, response.status)
  }
  if (!response.body) throw new ApiError('Сервер не вернул поток прогресса', response.status)

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let result: { count: number } | null = null

  const consumeLine = (line: string) => {
    if (!line.trim()) return
    const event = JSON.parse(line) as ({ type: 'progress' } & TransferProgress) | { type: 'complete'; count: number } | { type: 'error'; error: string }
    if (event.type === 'progress') onProgress?.(event)
    else if (event.type === 'complete') result = { count: event.count }
    else throw new ApiError(event.error, response.status)
  }

  while (true) {
    const { value, done } = await reader.read()
    buffer += decoder.decode(value, { stream: !done })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    lines.forEach(consumeLine)
    if (done) break
  }
  consumeLine(buffer)
  if (!result) throw new ApiError('Поток прогресса завершился преждевременно', response.status)
  return result
}

export function copyObject(item: S3Object, targetKey: string, onProgress?: (progress: TransferProgress) => void) {
  return transferObject('/api/objects/copy', item, targetKey, onProgress)
}

export function moveObject(item: S3Object, targetKey: string, onProgress?: (progress: TransferProgress) => void) {
  return transferObject('/api/objects/move', item, targetKey, onProgress)
}

export function deleteObject(item: S3Object) {
  return request<{ count: number }>('/api/objects', {
    method: 'DELETE',
    body: JSON.stringify({ key: item.key, type: item.type }),
  })
}
