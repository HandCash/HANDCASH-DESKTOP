import express, { type Response } from 'express'
import type { AddressInfo } from 'node:net'
import { request, type Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { jsonRequestErrors } from './requestErrors.js'

let server: Server
let port: number

beforeAll(async () => {
  const app = express()
  app.use(express.json({ limit: '1kb' }))
  app.post('/ok', (req, res) => res.json(req.body))
  app.post('/throws', () => {
    throw new Error('secret /Users/someone/path')
  })
  app.use(jsonRequestErrors((res: Response) => res.header('Access-Control-Allow-Origin', '*')))
  server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s))
  })
  port = (server.address() as AddressInfo).port
})

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

interface Answer {
  status: number
  headers: Record<string, string | string[] | undefined>
  text: string
}

// The hermetic setup stubs fetch, so this talks to the local server over node:http.
const post = (path: string, body: string) =>
  new Promise<Answer>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => (text += chunk))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }))
    })
    req.on('error', reject)
    req.end(body)
  })

describe('jsonRequestErrors', () => {
  it('answers malformed JSON as a JSON 400 with no stack or paths', async () => {
    const res = await post('/ok', '{nope')
    expect(res.status).toBe(400)
    expect(res.headers['content-type']).toMatch(/application\/json/)
    expect(res.headers['access-control-allow-origin']).toBe('*')
    const { text } = res
    expect(JSON.parse(text)).toEqual({ status: 'error', code: 'BAD_REQUEST', description: 'The request body is not valid JSON or text.', class: 'invalid-request', fault: 'application', retry: 'unsafe' })
    expect(text).not.toMatch(/SyntaxError|node_modules|\/Users\//)
  })

  it('answers an oversized body as a JSON 413', async () => {
    const res = await post('/ok', JSON.stringify({ a: 'x'.repeat(2048) }))
    expect(res.status).toBe(413)
    expect(JSON.parse(res.text).code).toBe('BODY_TOO_LARGE')
  })

  it('answers a route that throws as a JSON 500 without its message', async () => {
    const res = await post('/throws', '{}')
    expect(res.status).toBe(500)
    const { text } = res
    expect(JSON.parse(text).code).toBe('HTTP_ERROR')
    expect(text).not.toMatch(/secret|\/Users\//)
  })

  it('leaves good requests alone', async () => {
    const res = await post('/ok', '{"a":1}')
    expect(JSON.parse(res.text)).toEqual({ a: 1 })
  })
})
