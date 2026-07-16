import { CopyObjectCommand, DeleteObjectsCommand, ListObjectsV2Command, type S3Client } from '@aws-sdk/client-s3'
import { describe, expect, it, vi } from 'vitest'
import { copyObject, deleteObject, listObjects, moveObject } from './s3-service.js'
import type { StoredConnection } from './types.js'

const connection: StoredConnection = {
  id: 'test',
  name: 'Test',
  endpoint: 'https://s3.example.com',
  bucket: 'bucket',
  region: 'test-1',
  accessKeyId: 'access',
  secretAccessKey: 'secret',
  forcePathStyle: true,
  isDefault: false,
}

function fakeClient(send: (command: unknown) => unknown) {
  return { send: vi.fn(send) } as unknown as S3Client
}

describe('listObjects', () => {
  it('maps folders, files and continuation tokens', async () => {
    const client = fakeClient(() => ({
      CommonPrefixes: [{ Prefix: '/' }, { Prefix: 'photos/' }],
      Contents: [
        { Key: 'readme.txt', Size: 12, LastModified: new Date('2026-01-02T03:04:05Z'), ETag: '"etag"' },
      ],
      IsTruncated: true,
      NextContinuationToken: 'next',
    }))

    const result = await listObjects(client, connection, '', undefined, 50)

    expect(result.nextToken).toBe('next')
    expect(result.items).toEqual([
      { key: '/', name: '/', type: 'folder', size: 0, lastModified: null },
      { key: 'photos/', name: 'photos', type: 'folder', size: 0, lastModified: null },
      { key: 'readme.txt', name: 'readme.txt', type: 'file', size: 12, lastModified: '2026-01-02T03:04:05.000Z', etag: 'etag' },
    ])
  })

  it('keeps the requested page size within safe bounds', async () => {
    const client = fakeClient(() => ({}))
    await listObjects(client, connection, '', undefined, 10_000)
    const command = vi.mocked(client.send).mock.calls[0][0] as ListObjectsV2Command
    expect(command.input.MaxKeys).toBe(200)
  })
})

describe('mutating operations', () => {
  it('copies a folder tree while preserving relative paths', async () => {
    const commands: unknown[] = []
    const client = fakeClient((command) => {
      commands.push(command)
      if (command instanceof ListObjectsV2Command) return { Contents: [{ Key: 'old/' }, { Key: 'old/nested/file.txt' }] }
      return {}
    })

    expect(await copyObject(client, connection, 'old/', 'new/', true)).toBe(2)
    const copies = commands.filter((command): command is CopyObjectCommand => command instanceof CopyObjectCommand)
    expect(copies.map((command) => command.input.Key)).toEqual(['new/', 'new/nested/file.txt'])
    expect(commands.some((command) => command instanceof DeleteObjectsCommand)).toBe(false)
  })

  it('rejects copying a folder into itself', async () => {
    const client = fakeClient(() => ({}))
    await expect(copyObject(client, connection, 'old/', 'old/nested/', true)).rejects.toThrow('самой себя')
    expect(client.send).not.toHaveBeenCalled()
  })

  it('moves a folder only after every object was copied', async () => {
    const commands: unknown[] = []
    const client = fakeClient((command) => {
      commands.push(command)
      if (command instanceof ListObjectsV2Command) return { Contents: [{ Key: 'old/' }, { Key: 'old/file.txt' }] }
      return {}
    })

    const count = await moveObject(client, connection, 'old/', 'new', true)
    const copies = commands.filter((command): command is CopyObjectCommand => command instanceof CopyObjectCommand)

    expect(count).toBe(2)
    expect(copies.map((command) => command.input.Key)).toEqual(['new/', 'new/file.txt'])
    expect(commands.findIndex((command) => command instanceof DeleteObjectsCommand)).toBeGreaterThan(
      Math.max(...commands.map((command, index) => command instanceof CopyObjectCommand ? index : -1)),
    )
  })

  it('reports copy and delete progress while moving a folder', async () => {
    const client = fakeClient((command) => {
      if (command instanceof ListObjectsV2Command) return { Contents: [{ Key: 'old/' }, { Key: 'old/file.txt' }] }
      return {}
    })
    const progress = vi.fn()

    await moveObject(client, connection, 'old/', 'new/', true, progress)

    expect(progress.mock.calls.map(([event]) => event)).toEqual([
      { phase: 'copying', completed: 0, total: 2 },
      { phase: 'copying', completed: 1, total: 2 },
      { phase: 'copying', completed: 2, total: 2 },
      { phase: 'deleting', completed: 0, total: 2 },
      { phase: 'deleting', completed: 2, total: 2 },
    ])
  })

  it('deletes large folders in S3 batches', async () => {
    const commands: unknown[] = []
    const client = fakeClient((command) => {
      commands.push(command)
      if (command instanceof ListObjectsV2Command) return { Contents: Array.from({ length: 1001 }, (_, index) => ({ Key: `folder/${index}` })) }
      return {}
    })

    expect(await deleteObject(client, connection, 'folder/', true)).toBe(1001)
    const batches = commands.filter((command): command is DeleteObjectsCommand => command instanceof DeleteObjectsCommand)
    expect(batches).toHaveLength(2)
    expect(batches.map((command) => command.input.Delete?.Objects?.length)).toEqual([1000, 1])
  })
})
