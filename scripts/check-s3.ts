import { loadEnvFile } from 'node:process'
import { ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3'

loadEnvFile('.env')

for (const forcePathStyle of [true, false]) {
  const client = new S3Client({
    endpoint: process.env.S3_ENDPOINT,
    region: process.env.S3_REGION,
    forcePathStyle,
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY_ID!,
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY!,
    },
  })

  try {
    const result = await client.send(new ListObjectsV2Command({ Bucket: process.env.S3_BUCKET, MaxKeys: 3 }))
    console.log({ forcePathStyle, ok: true, count: result.Contents?.length ?? 0, truncated: result.IsTruncated ?? false })
  } catch (error) {
    const known = error as Error & { $metadata?: { httpStatusCode?: number } }
    console.error({ forcePathStyle, ok: false, name: known.name, message: known.message, status: known.$metadata?.httpStatusCode })
  } finally {
    client.destroy()
  }
}
