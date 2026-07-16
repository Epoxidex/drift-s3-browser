import {
  CopyObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3'
import { Upload } from '@aws-sdk/lib-storage'
import * as archiverModule from 'archiver'
import { once } from 'node:events'
import { PassThrough, type Readable } from 'node:stream'
import type { StoredConnection } from './types.js'

export type ObjectItem = {
  key: string
  name: string
  type: 'folder' | 'file'
  size: number
  lastModified: string | null
  etag?: string
}

export type TransferProgress = {
  phase: 'copying' | 'deleting'
  completed: number
  total: number
}

type ProgressCallback = (progress: TransferProgress) => void

export async function listObjects(client: S3Client, connection: StoredConnection, prefix: string, continuationToken?: string, pageSize = 50) {
  const response = await client.send(new ListObjectsV2Command({
    Bucket: connection.bucket,
    Prefix: prefix,
    Delimiter: '/',
    ContinuationToken: continuationToken,
    MaxKeys: Math.min(Math.max(pageSize, 10), 200),
  }))

  const folders: ObjectItem[] = (response.CommonPrefixes ?? []).flatMap(({ Prefix }) => Prefix ? [{
    key: Prefix,
    name: Prefix.slice(prefix.length).replace(/\/$/, '') || '/',
    type: 'folder' as const,
    size: 0,
    lastModified: null,
  }] : [])

  const files: ObjectItem[] = (response.Contents ?? []).flatMap((object) => object.Key && object.Key !== prefix ? [{
    key: object.Key,
    name: object.Key.slice(prefix.length),
    type: 'file' as const,
    size: object.Size ?? 0,
    lastModified: object.LastModified?.toISOString() ?? null,
    etag: object.ETag?.replaceAll('"', ''),
  }] : [])

  return {
    items: [...folders, ...files],
    nextToken: response.NextContinuationToken ?? null,
    isTruncated: response.IsTruncated ?? false,
  }
}

export async function headObject(client: S3Client, connection: StoredConnection, key: string) {
  return client.send(new HeadObjectCommand({ Bucket: connection.bucket, Key: key }))
}

export async function getObject(client: S3Client, connection: StoredConnection, key: string, range?: string) {
  return client.send(new GetObjectCommand({ Bucket: connection.bucket, Key: key, Range: range }))
}

function safeArchivePath(value: string) {
  return value.split('/').filter(Boolean).map((part) => part === '..' || part === '.' ? '_' : part).join('/')
}

export async function createFolderArchive(client: S3Client, connection: StoredConnection, prefix: string) {
  const keys = await listAllKeys(client, connection, prefix)
  const output = new PassThrough()
  const ZipArchive = (archiverModule as unknown as {
    ZipArchive: new(options?: archiverModule.ArchiverOptions) => archiverModule.Archiver
  }).ZipArchive
  const archive = new ZipArchive({ zlib: { level: 6 } })
  const rootName = safeArchivePath(prefix.replace(/\/$/, '').split('/').pop() || 'bucket')

  archive.on('warning', (error) => {
    if (error.code !== 'ENOENT') output.destroy(error)
  })
  archive.on('error', (error) => output.destroy(error))
  archive.pipe(output)

  void (async () => {
    archive.append('', { name: `${rootName}/` })
    for (const key of keys) {
      const relativePath = safeArchivePath(key.slice(prefix.length))
      if (!relativePath) continue
      const archivePath = `${rootName}/${relativePath}${key.endsWith('/') ? '/' : ''}`
      if (key.endsWith('/')) {
        archive.append('', { name: archivePath })
        continue
      }
      const object = await getObject(client, connection, key)
      const body = object.Body as Readable | undefined
      if (!body) throw new Error(`S3 вернул пустой поток для ${key}`)
      const completed = once(body, 'end')
      archive.append(body, { name: archivePath, date: object.LastModified })
      await completed
    }
    await archive.finalize()
  })().catch((error) => output.destroy(error instanceof Error ? error : new Error('Не удалось создать ZIP-архив')))

  return { stream: output, count: keys.length, filename: `${rootName}.zip` }
}

export async function uploadObject(client: S3Client, connection: StoredConnection, key: string, body: Readable, contentType: string) {
  const upload = new Upload({
    client,
    params: { Bucket: connection.bucket, Key: key, Body: body, ContentType: contentType },
    queueSize: 4,
    partSize: 8 * 1024 * 1024,
  })
  await upload.done()
}

export async function createFolder(client: S3Client, connection: StoredConnection, key: string) {
  const folderKey = key.endsWith('/') ? key : `${key}/`
  await client.send(new PutObjectCommand({ Bucket: connection.bucket, Key: folderKey, Body: '' }))
}

export async function listAllKeys(client: S3Client, connection: StoredConnection, prefix: string) {
  const keys: string[] = []
  let token: string | undefined
  do {
    const page = await client.send(new ListObjectsV2Command({ Bucket: connection.bucket, Prefix: prefix, ContinuationToken: token, MaxKeys: 1000 }))
    keys.push(...(page.Contents ?? []).flatMap((item) => item.Key ? [item.Key] : []))
    token = page.NextContinuationToken
  } while (token)
  return keys
}

export async function deleteObject(client: S3Client, connection: StoredConnection, key: string, isFolder: boolean) {
  if (!isFolder) {
    await client.send(new DeleteObjectCommand({ Bucket: connection.bucket, Key: key }))
    return 1
  }
  const keys = await listAllKeys(client, connection, key)
  await deleteKeys(client, connection, keys)
  return keys.length
}

async function deleteKeys(client: S3Client, connection: StoredConnection, keys: string[], onProgress?: (completed: number) => void) {
  for (let index = 0; index < keys.length; index += 1000) {
    await client.send(new DeleteObjectsCommand({
      Bucket: connection.bucket,
      Delete: { Objects: keys.slice(index, index + 1000).map((Key) => ({ Key })), Quiet: true },
    }))
    onProgress?.(Math.min(index + 1000, keys.length))
  }
}

function encodeCopySource(bucket: string, key: string) {
  return `/${encodeURIComponent(bucket)}/${key.split('/').map(encodeURIComponent).join('/')}`
}

export async function moveObject(client: S3Client, connection: StoredConnection, sourceKey: string, targetKey: string, isFolder: boolean, onProgress?: ProgressCallback) {
  if (!validateCopyTarget(sourceKey, targetKey, isFolder)) return 0
  const sourceKeys = isFolder ? await listAllKeys(client, connection, sourceKey) : [sourceKey]
  onProgress?.({ phase: 'copying', completed: 0, total: sourceKeys.length })
  await copyKeys(client, connection, sourceKeys, sourceKey, targetKey, isFolder, onProgress)
  onProgress?.({ phase: 'deleting', completed: 0, total: sourceKeys.length })
  if (isFolder) {
    await deleteKeys(client, connection, sourceKeys, (completed) => onProgress?.({ phase: 'deleting', completed, total: sourceKeys.length }))
  } else {
    await client.send(new DeleteObjectCommand({ Bucket: connection.bucket, Key: sourceKey }))
    onProgress?.({ phase: 'deleting', completed: 1, total: 1 })
  }
  return sourceKeys.length
}

export async function copyObject(client: S3Client, connection: StoredConnection, sourceKey: string, targetKey: string, isFolder: boolean, onProgress?: ProgressCallback) {
  if (!validateCopyTarget(sourceKey, targetKey, isFolder)) return 0
  const sourceKeys = isFolder ? await listAllKeys(client, connection, sourceKey) : [sourceKey]
  onProgress?.({ phase: 'copying', completed: 0, total: sourceKeys.length })
  await copyKeys(client, connection, sourceKeys, sourceKey, targetKey, isFolder, onProgress)
  return sourceKeys.length
}

function validateCopyTarget(sourceKey: string, targetKey: string, isFolder: boolean) {
  if (sourceKey === targetKey) return false
  if (isFolder && targetKey.startsWith(sourceKey)) throw new Error('Нельзя скопировать папку внутрь самой себя')
  return true
}

async function copyKeys(client: S3Client, connection: StoredConnection, sourceKeys: string[], sourceKey: string, targetKey: string, isFolder: boolean, onProgress?: ProgressCallback) {
  const targetPrefix = isFolder ? (targetKey.endsWith('/') ? targetKey : `${targetKey}/`) : targetKey
  const sourcePrefix = isFolder ? sourceKey : ''
  let completed = 0

  for (let index = 0; index < sourceKeys.length; index += 8) {
    await Promise.all(sourceKeys.slice(index, index + 8).map(async (key) => {
      await client.send(new CopyObjectCommand({
        Bucket: connection.bucket,
        Key: isFolder ? `${targetPrefix}${key.slice(sourcePrefix.length)}` : targetPrefix,
        CopySource: encodeCopySource(connection.bucket, key),
      }))
      completed += 1
      onProgress?.({ phase: 'copying', completed, total: sourceKeys.length })
    }))
  }
}
