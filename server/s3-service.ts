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
import type { Readable } from 'node:stream'
import type { StoredConnection } from './types.js'

export type ObjectItem = {
  key: string
  name: string
  type: 'folder' | 'file'
  size: number
  lastModified: string | null
  etag?: string
}

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

async function listAllKeys(client: S3Client, connection: StoredConnection, prefix: string) {
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
  for (let index = 0; index < keys.length; index += 1000) {
    await client.send(new DeleteObjectsCommand({
      Bucket: connection.bucket,
      Delete: { Objects: keys.slice(index, index + 1000).map((Key) => ({ Key })), Quiet: true },
    }))
  }
  return keys.length
}

function encodeCopySource(bucket: string, key: string) {
  return `/${encodeURIComponent(bucket)}/${key.split('/').map(encodeURIComponent).join('/')}`
}

export async function moveObject(client: S3Client, connection: StoredConnection, sourceKey: string, targetKey: string, isFolder: boolean) {
  if (sourceKey === targetKey) return 0
  if (isFolder && targetKey.startsWith(sourceKey)) throw new Error('Нельзя переместить папку внутрь самой себя')

  const sourceKeys = isFolder ? await listAllKeys(client, connection, sourceKey) : [sourceKey]
  const targetPrefix = isFolder ? (targetKey.endsWith('/') ? targetKey : `${targetKey}/`) : targetKey
  const sourcePrefix = isFolder ? sourceKey : ''

  for (let index = 0; index < sourceKeys.length; index += 5) {
    await Promise.all(sourceKeys.slice(index, index + 5).map((key) => client.send(new CopyObjectCommand({
      Bucket: connection.bucket,
      Key: isFolder ? `${targetPrefix}${key.slice(sourcePrefix.length)}` : targetPrefix,
      CopySource: encodeCopySource(connection.bucket, key),
    }))))
  }

  await deleteObject(client, connection, sourceKey, isFolder)
  return sourceKeys.length
}
