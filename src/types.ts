export type Connection = {
  id: string
  name: string
  endpoint: string
  bucket: string
  region: string
  isDefault: boolean
}

export type S3Object = {
  key: string
  name: string
  type: 'folder' | 'file'
  size: number
  lastModified: string | null
  etag?: string
}

export type ObjectPage = {
  items: S3Object[]
  nextToken: string | null
  isTruncated: boolean
}

export type ObjectMeta = {
  key: string
  size: number
  contentType: string
  lastModified: string | null
  etag: string | null
  metadata: Record<string, string>
}

