import { access } from 'node:fs/promises'
import path from 'node:path'
import { PassThrough, type Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import multipart from '@fastify/multipart'
import cookie from '@fastify/cookie'
import fastifyStatic from '@fastify/static'
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify'
import { lookup as lookupMime } from 'mime-types'
import { addConnection, addDefaultConnectionFromEnv, getClient, getConnection, listConnections, parseConnection, removeConnection } from './connection-store.js'
import { copyObject, createFolder, createFolderArchive, deleteObject, getObject, headObject, listObjects, moveObject, uploadObject, type TransferProgress } from './s3-service.js'

type Query = Record<string, string | undefined>

function requireConnection(request: FastifyRequest) {
  const headerId = request.headers['x-s3-connection']
  const id = Array.isArray(headerId) ? headerId[0] : headerId
  const connection = getConnection(id || request.cookies.s3_connection)
  if (!connection) {
    const error = new Error('Подключение не найдено или сервер был перезапущен') as Error & { statusCode: number }
    error.statusCode = 401
    throw error
  }
  return connection
}

function requiredString(value: unknown, label: string) {
  if (typeof value !== 'string' || !value) throw new Error(`Не указано поле «${label}»`)
  return value
}

function sendTransferProgress(reply: FastifyReply, run: (onProgress: (progress: TransferProgress) => void) => Promise<number>) {
  const stream = new PassThrough()
  const write = (event: Record<string, unknown>) => stream.write(`${JSON.stringify(event)}\n`)
  reply.header('content-type', 'application/x-ndjson; charset=utf-8')
  void run((progress) => write({ type: 'progress', ...progress }))
    .then((count) => {
      write({ type: 'complete', count })
      stream.end()
    })
    .catch((error) => {
      write({ type: 'error', error: error instanceof Error ? error.message : 'Операция не выполнена' })
      stream.end()
    })
  return reply.send(stream)
}

export async function buildApp() {
  const app = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024 })
  addDefaultConnectionFromEnv()

  await app.register(cookie)
  await app.register(multipart, {
    limits: { files: 1, fileSize: 5 * 1024 ** 4 },
    throwFileSizeLimit: true,
  })

  app.get('/api/health', async () => ({ ok: true }))
  app.get('/api/connections', async () => ({ connections: listConnections() }))

  app.post('/api/connections', async (request, reply) => {
    const connection = await addConnection(parseConnection(request.body))
    return reply.code(201).send({ connection })
  })

  app.post<{ Params: { id: string } }>('/api/connections/:id/activate', async (request, reply) => {
    if (!getConnection(request.params.id)) return reply.code(404).send({ error: 'Подключение не найдено' })
    reply.setCookie('s3_connection', request.params.id, {
      httpOnly: true,
      sameSite: 'strict',
      path: '/',
      secure: false,
    })
    return reply.code(204).send()
  })

  app.delete<{ Params: { id: string } }>('/api/connections/:id', async (request, reply) => {
    if (!removeConnection(request.params.id)) return reply.code(404).send({ error: 'Подключение не найдено' })
    return reply.code(204).send()
  })

  app.get<{ Querystring: Query }>('/api/objects', async (request) => {
    const connection = requireConnection(request)
    return listObjects(getClient(connection), connection, request.query.prefix ?? '', request.query.token, Number(request.query.pageSize) || 50)
  })

  app.get<{ Querystring: Query }>('/api/objects/meta', async (request) => {
    const connection = requireConnection(request)
    const key = requiredString(request.query.key, 'key')
    const result = await headObject(getClient(connection), connection, key)
    return {
      key,
      size: result.ContentLength ?? 0,
      contentType: result.ContentType || lookupMime(key) || 'application/octet-stream',
      lastModified: result.LastModified?.toISOString() ?? null,
      etag: result.ETag?.replaceAll('"', '') ?? null,
      metadata: result.Metadata ?? {},
    }
  })

  app.get<{ Querystring: Query }>('/api/objects/content', async (request, reply) => {
    const connection = requireConnection(request)
    const key = requiredString(request.query.key, 'key')
    const client = getClient(connection)
    const result = await getObject(client, connection, key, request.headers.range)
    const filename = key.split('/').pop() || 'download'
    const detectedType = result.ContentType || lookupMime(key) || 'application/octet-stream'
    const safeInline = /^(image\/(png|jpeg|gif|webp|avif)|application\/pdf|text\/plain)/.test(String(detectedType))
    const download = request.query.download === '1'

    reply.header('content-type', safeInline ? detectedType : 'application/octet-stream')
    reply.header('content-disposition', `${download || !safeInline ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(filename)}`)
    reply.header('accept-ranges', 'bytes')
    if (result.ContentLength !== undefined) reply.header('content-length', result.ContentLength)
    if (result.ContentRange) reply.header('content-range', result.ContentRange)
    if (result.ETag) reply.header('etag', result.ETag)
    if (result.$metadata.httpStatusCode === 206) reply.code(206)

    const stream = result.Body as Readable | undefined
    if (!stream) {
      return reply.code(502).send({ error: 'S3 вернул пустой поток' })
    }

    return reply.send(stream)
  })

  app.get<{ Querystring: Query }>('/api/objects/archive', async (request, reply) => {
    const connection = requireConnection(request)
    const prefix = requiredString(request.query.prefix, 'prefix')
    const result = await createFolderArchive(getClient(connection), connection, prefix)
    reply.header('content-type', 'application/zip')
    reply.header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(result.filename)}`)
    reply.header('x-archive-object-count', result.count)
    return reply.send(result.stream)
  })

  app.post<{ Querystring: Query }>('/api/objects/upload', async (request, reply) => {
    const connection = requireConnection(request)
    const prefix = request.query.prefix ?? ''
    const part = await request.file()
    if (!part) return reply.code(400).send({ error: 'Файл не передан' })
    const relativePath = (request.query.relativePath || part.filename)
      .replaceAll('\\', '/')
      .split('/')
      .filter((segment) => segment && segment !== '.' && segment !== '..')
      .join('/')
    if (!relativePath) return reply.code(400).send({ error: 'Некорректный путь файла' })
    const key = `${prefix}${relativePath}`
    await uploadObject(getClient(connection), connection, key, part.file, part.mimetype)
    return reply.code(201).send({ key })
  })

  app.post('/api/objects/folder', async (request, reply) => {
    const connection = requireConnection(request)
    const body = request.body as Record<string, unknown>
    const key = requiredString(body?.key, 'key')
    await createFolder(getClient(connection), connection, key)
    return reply.code(201).send({ key: key.endsWith('/') ? key : `${key}/` })
  })

  app.post('/api/objects/copy', async (request, reply) => {
    const connection = requireConnection(request)
    const body = request.body as Record<string, unknown>
    const sourceKey = requiredString(body?.sourceKey, 'sourceKey')
    const targetKey = requiredString(body?.targetKey, 'targetKey')
    return sendTransferProgress(reply, (onProgress) => copyObject(getClient(connection), connection, sourceKey, targetKey, body?.type === 'folder', onProgress))
  })

  app.post('/api/objects/move', async (request, reply) => {
    const connection = requireConnection(request)
    const body = request.body as Record<string, unknown>
    const sourceKey = requiredString(body?.sourceKey, 'sourceKey')
    const targetKey = requiredString(body?.targetKey, 'targetKey')
    return sendTransferProgress(reply, (onProgress) => moveObject(getClient(connection), connection, sourceKey, targetKey, body?.type === 'folder', onProgress))
  })

  app.delete('/api/objects', async (request) => {
    const connection = requireConnection(request)
    const body = request.body as Record<string, unknown>
    const key = requiredString(body?.key, 'key')
    return { count: await deleteObject(getClient(connection), connection, key, body?.type === 'folder') }
  })

  app.setErrorHandler((error, _request, reply) => {
    const knownError = error instanceof Error ? error : new Error('Неизвестная ошибка')
    const statusCode = 'statusCode' in knownError && typeof knownError.statusCode === 'number' ? knownError.statusCode : 500
    const safeMessage = statusCode < 500 || knownError.name === 'NoSuchKey'
      ? knownError.message
      : 'S3 не смог выполнить операцию. Проверьте подключение и права доступа.'
    reply.code(statusCode).send({ error: safeMessage, code: knownError.name })
  })

  const dirname = path.dirname(fileURLToPath(import.meta.url))
  const clientRoot = path.resolve(dirname, '../dist/client')
  try {
    await access(clientRoot)
    await app.register(fastifyStatic, { root: clientRoot, wildcard: false })
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/')) return reply.code(404).send({ error: 'Маршрут не найден' })
      return reply.sendFile('index.html')
    })
  } catch {
    // Vite serves the UI in development.
  }

  return app
}
