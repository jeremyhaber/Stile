import { describe, expect, it } from 'vitest'
import aws4 from 'aws4'
// @ts-expect-error plain JS module
import { presign, signHeaders, sha256Hex, objectUrl, objectKey, publicLink, uriEncode } from '../../../extension/capture/s3.js'

const AK = 'AKIAIOSFODNN7EXAMPLE'
const SK = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'
const D = new Date('2013-05-24T00:00:00Z')

describe('SigV4 (AWS documented examples)', () => {
  it('presigned GET (S3 docs, expires 86400)', async () => {
    const r = await presign({ url: 'https://examplebucket.s3.amazonaws.com/test.txt', region: 'us-east-1', accessKeyId: AK, secretAccessKey: SK, expires: 86400, date: D })
    expect(r.signature).toBe('aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404')
    expect(r.url).toBe(
      'https://examplebucket.s3.amazonaws.com/test.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404',
    )
  })
  it('header-based GET with Range (S3 docs)', async () => {
    const r = await signHeaders({ method: 'GET', url: 'https://examplebucket.s3.amazonaws.com/test.txt', headers: { range: 'bytes=0-9' }, payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', region: 'us-east-1', accessKeyId: AK, secretAccessKey: SK, date: D })
    expect(r.signature).toBe('f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41')
  })
  it('header-based PUT with storage class (S3 docs)', async () => {
    const body = 'Welcome to Amazon S3.'
    const hash = await sha256Hex(body)
    expect(hash).toBe('44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072')
    const r = await signHeaders({ method: 'PUT', url: 'https://examplebucket.s3.amazonaws.com/test$file.text', headers: { date: 'Fri, 24 May 2013 00:00:00 GMT', 'x-amz-date': '20130524T000000Z', 'x-amz-storage-class': 'REDUCED_REDUNDANCY' }, payloadHash: hash, region: 'us-east-1', accessKeyId: AK, secretAccessKey: SK, date: D })
    expect(r.signature).toBe('98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd')
  })
})

describe('agrees with the aws4 library on arbitrary requests', () => {
  it('PUT with odd key characters, custom port and virtual / path style', async () => {
    const cfg = { endpoint: 'http://127.0.0.1:9123', region: 'auto', bucket: 'b', style: 'path' }
    const key = 'screenshots/2026/10/Screenshot 2026-10-23 at 14.03.22 (1)!.png'
    const url = objectUrl(cfg, key)
    const body = new Uint8Array([1, 2, 3, 4])
    const hash = await sha256Hex(body)
    const date = new Date('2026-10-23T14:03:22Z')
    const mine = await signHeaders({ method: 'PUT', url, headers: { 'content-type': 'image/png', 'content-length': '4' }, payloadHash: hash, region: 'auto', accessKeyId: AK, secretAccessKey: SK, date })
    const u = new URL(url)
    const theirs = aws4.sign({ host: u.host, method: 'PUT', path: u.pathname + u.search, service: 's3', region: 'auto', headers: { 'Content-Type': 'image/png', 'X-Amz-Content-Sha256': hash, 'X-Amz-Date': '20261023T140322Z' }, body: Buffer.from(body), signQuery: false }, { accessKeyId: AK, secretAccessKey: SK })
    const sig = (a: string) => /Signature=([0-9a-f]+)/.exec(a)![1]
    expect(sig(mine.authorization)).toBe(sig((theirs.headers as any).Authorization))
  })
})

describe('keys and links', () => {
  it('addressing styles', () => {
    expect(objectUrl({ endpoint: 'https://s3.eu-west-1.amazonaws.com', region: 'eu-west-1', bucket: 'bkt', style: 'virtual' }, 'a b/c.png')).toBe('https://bkt.s3.eu-west-1.amazonaws.com/a%20b/c.png')
    expect(objectUrl({ endpoint: 'https://x.r2.cloudflarestorage.com', region: 'auto', bucket: 'bkt', style: 'path' }, 'a/c.png')).toBe('https://x.r2.cloudflarestorage.com/bkt/a/c.png')
  })
  it('prefix tokens, naming and public link', () => {
    const d = new Date(2026, 9, 3, 4, 5, 6)
    expect(objectKey({ prefix: 'shots/{yyyy}/{mm}/', naming: 'timestamp' }, d)).toBe('shots/2026/10/Screenshot 2026-10-03 at 04.05.06.png')
    expect(objectKey({ prefix: '', naming: 'random' }, d, 'abc')).toBe('abc.png')
    expect(objectKey({ prefix: '/x', naming: 'random' }, d, 'abc')).toBe('x/abc.png')
    expect(publicLink({ publicBase: 'https://shots.example.com' }, 'a b/c.png')).toBe('https://shots.example.com/a%20b/c.png')
    expect(uriEncode("a!'()*")).toBe('a%21%27%28%29%2A')
  })
})
