import { randomUUID } from 'node:crypto'
import { ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3'
import type { ConnectionInput, ConnectionSummary, StoredConnection } from './types.js'

const connections = new Map<string, StoredConnection>()

function assertText(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Поле «${label}» обязательно`)
  }
}

export function parseConnection(input: unknown): ConnectionInput {
  if (!input || typeof input !== 'object') throw new Error('Некорректные параметры подключения')
  const value = input as Record<string, unknown>

  assertText(value.endpoint, 'S3 URL')
  assertText(value.bucket, 'Название бакета')
  assertText(value.region, 'Регион')
  assertText(value.accessKeyId, 'Access Key')
  assertText(value.secretAccessKey, 'Secret Key')

  const endpoint = value.endpoint.replace(/\/$/, '')
  const url = new URL(endpoint)
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('S3 URL должен использовать HTTP или HTTPS')

  return {
    name: typeof value.name === 'string' ? value.name.trim() : undefined,
    endpoint,
    bucket: value.bucket.trim(),
    region: value.region.trim(),
    accessKeyId: value.accessKeyId.trim(),
    secretAccessKey: value.secretAccessKey,
    forcePathStyle: value.forcePathStyle !== false,
  }
}

export function createClient(connection: StoredConnection) {
  return new S3Client({
    endpoint: connection.endpoint,
    region: connection.region,
    forcePathStyle: connection.forcePathStyle,
    credentials: {
      accessKeyId: connection.accessKeyId,
      secretAccessKey: connection.secretAccessKey,
    },
  })
}

function summary(connection: StoredConnection): ConnectionSummary {
  const { accessKeyId: _accessKeyId, secretAccessKey: _secretAccessKey, forcePathStyle: _forcePathStyle, ...safe } = connection
  return safe
}

export async function addConnection(input: ConnectionInput, isDefault = false) {
  const connection: StoredConnection = {
    ...input,
    id: randomUUID(),
    name: input.name || input.bucket,
    forcePathStyle: input.forcePathStyle !== false,
    isDefault,
  }

  const client = createClient(connection)
  try {
    await client.send(new ListObjectsV2Command({ Bucket: connection.bucket, MaxKeys: 1 }))
  } finally {
    client.destroy()
  }

  connections.set(connection.id, connection)
  return summary(connection)
}

export function addDefaultConnectionFromEnv() {
  const required = [process.env.S3_ENDPOINT, process.env.S3_BUCKET, process.env.S3_REGION, process.env.S3_ACCESS_KEY_ID, process.env.S3_SECRET_ACCESS_KEY]
  if (required.some((value) => !value)) return null

  const connection: StoredConnection = {
    id: randomUUID(),
    name: 'Локальный бакет',
    endpoint: process.env.S3_ENDPOINT!,
    bucket: process.env.S3_BUCKET!,
    region: process.env.S3_REGION!,
    accessKeyId: process.env.S3_ACCESS_KEY_ID!,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY!,
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== 'false',
    isDefault: true,
  }
  connections.set(connection.id, connection)
  return summary(connection)
}

export function getConnection(id: string | undefined) {
  return id ? connections.get(id) : undefined
}

export function listConnections() {
  return [...connections.values()].map(summary)
}

export function removeConnection(id: string) {
  const connection = connections.get(id)
  if (!connection || connection.isDefault) return false
  connections.delete(id)
  return true
}

