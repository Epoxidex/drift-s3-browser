export type ConnectionInput = {
  name?: string
  endpoint: string
  bucket: string
  region: string
  accessKeyId: string
  secretAccessKey: string
  forcePathStyle?: boolean
}

export type ConnectionSummary = {
  id: string
  name: string
  endpoint: string
  bucket: string
  region: string
  isDefault: boolean
}

export type StoredConnection = ConnectionSummary & {
  accessKeyId: string
  secretAccessKey: string
  forcePathStyle: boolean
}

