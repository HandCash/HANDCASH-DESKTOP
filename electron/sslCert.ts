import { app } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import forge from 'node-forge'

export type CertificateKeyPair = {
  cert: string
  key: string
  certPath: string
}

/** True when the PEM cert lists IPv6 loopback in SAN (needed for localhost → ::1). */
export function certHasIpv6LoopbackSan(certPem: string): boolean {
  try {
    const forgeCert = forge.pki.certificateFromPem(certPem)
    const ext = forgeCert.getExtension('subjectAltName') as
      | { altNames?: Array<{ type?: number; ip?: string; value?: string }> }
      | false
      | null
    if (!ext || !Array.isArray(ext.altNames)) return false
    return ext.altNames.some(
      (n) => n.type === 7 && typeof n.ip === 'string' && n.ip === '::1',
    )
  } catch {
    return false
  }
}

function writeNewCert(certDir: string, certPath: string, keyPath: string): CertificateKeyPair {
  if (!fs.existsSync(certDir)) fs.mkdirSync(certDir, { recursive: true })

  const keys = forge.pki.rsa.generateKeyPair(2048)
  const cert = forge.pki.createCertificate()
  cert.publicKey = keys.publicKey
  cert.serialNumber = Date.now().toString(16)
  cert.validity.notBefore = new Date()
  cert.validity.notAfter = new Date()
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 2)

  const attrs = [
    { name: 'commonName', value: 'localhost' },
    { name: 'organizationName', value: 'HandCash BRC100' },
    { shortName: 'OU', value: 'Desktop Wallet' },
  ]
  cert.setSubject(attrs)
  cert.setIssuer(attrs)
  cert.setExtensions([
    { name: 'basicConstraints', cA: false },
    {
      name: 'keyUsage',
      digitalSignature: true,
      keyEncipherment: true,
    },
    {
      name: 'extKeyUsage',
      serverAuth: true,
    },
    {
      name: 'subjectAltName',
      altNames: [
        { type: 2, value: 'localhost' },
        { type: 7, ip: '127.0.0.1' },
        { type: 7, ip: '::1' },
      ],
    },
  ])
  cert.sign(keys.privateKey, forge.md.sha256.create())

  const certPem = forge.pki.certificateToPem(cert)
  const keyPem = forge.pki.privateKeyToPem(keys.privateKey)
  fs.writeFileSync(certPath, certPem, { mode: 0o600 })
  fs.writeFileSync(keyPath, keyPem, { mode: 0o600 })

  return { cert: certPem, key: keyPem, certPath }
}

export async function generateSelfSignedCert(): Promise<CertificateKeyPair> {
  const userDataPath = app.getPath('userData')
  const certDir = path.join(userDataPath, 'certs')
  const certPath = path.join(certDir, 'server.crt')
  const keyPath = path.join(certDir, 'server.key')

  if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    try {
      const cert = fs.readFileSync(certPath, 'utf8')
      const key = fs.readFileSync(keyPath, 'utf8')
      const forgeCert = forge.pki.certificateFromPem(cert)
      if (
        forgeCert.validity.notAfter > new Date() &&
        certHasIpv6LoopbackSan(cert)
      ) {
        return { cert, key, certPath }
      }
      // Expired or missing ::1 SAN — regenerate so WalletClient('auto') on ::1 works.
    } catch {
      // regenerate below
    }
  }

  return writeNewCert(certDir, certPath, keyPath)
}

/** Best-effort trust prompt stub — OS trust varies; apps can still use HTTP :3321. */
export async function ensureCertTrusted(_certPath: string): Promise<void> {
  return
}
