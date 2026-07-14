import { describe, expect, it } from 'vitest'
import { parseConnection } from './connection-store.js'

describe('parseConnection', () => {
  it('normalizes a valid S3-compatible connection', () => {
    expect(parseConnection({
      name: ' Archive ',
      endpoint: 'https://s3.example.com/',
      bucket: ' bucket ',
      region: ' test-1 ',
      accessKeyId: ' access ',
      secretAccessKey: 'secret',
    })).toEqual({
      name: 'Archive',
      endpoint: 'https://s3.example.com',
      bucket: 'bucket',
      region: 'test-1',
      accessKeyId: 'access',
      secretAccessKey: 'secret',
      forcePathStyle: true,
    })
  })

  it('rejects endpoints that are not HTTP-based', () => {
    expect(() => parseConnection({
      endpoint: 'file:///tmp/storage', bucket: 'bucket', region: 'test-1', accessKeyId: 'access', secretAccessKey: 'secret',
    })).toThrow('HTTP или HTTPS')
  })
})
