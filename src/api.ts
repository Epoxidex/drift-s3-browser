import type { Connection, ObjectMeta, ObjectPage, S3Object } from './types'

let connectionId = sessionStorage.getItem('s3-connection-id') || ''

export class ApiError extends Error {
  status: number

  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers)
  if (connectionId) headers.set('x-s3-connection', connectionId)
  if (options.body && !(options.body instanceof FormData)) headers.set('content-type', 'application/json')

  const response = await fetch(path, { ...options, headers })
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

export async function getTextPreview(key: string) {
  const response = await fetch(contentUrl(key), {
    headers: { 'x-s3-connection': connectionId, range: 'bytes=0-524287' },
  })
  if (!response.ok) throw new ApiError('Не удалось прочитать файл', response.status)
  return response.text()
}

export function createFolder(key: string) {
  return request<{ key: string }>('/api/objects/folder', { method: 'POST', body: JSON.stringify({ key }) })
}

export function uploadFile(prefix: string, file: File) {
  const form = new FormData()
  form.append('file', file)
  return request<{ key: string }>(`/api/objects/upload?${new URLSearchParams({ prefix })}`, { method: 'POST', body: form })
}

export function moveObject(item: S3Object, targetKey: string) {
  return request<{ count: number }>('/api/objects/move', {
    method: 'POST',
    body: JSON.stringify({ sourceKey: item.key, targetKey, type: item.type }),
  })
}

export function deleteObject(item: S3Object) {
  return request<{ count: number }>('/api/objects', {
    method: 'DELETE',
    body: JSON.stringify({ key: item.key, type: item.type }),
  })
}

