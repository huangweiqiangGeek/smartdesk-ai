import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { fail } from '../identity/input';

/** Keys stay on the API. Retain old key IDs for the entire receipt lifetime. */
export class ReceiptCipher {
  private keys = new Map<string, Buffer>();
  private active = process.env.BOOTSTRAP_ACTIVE_KEY_ID ?? '';
  constructor() {
    try {
      const values: unknown = JSON.parse(
        process.env.BOOTSTRAP_RECEIPT_KEYS ?? '{}',
      );
      if (!values || typeof values !== 'object' || Array.isArray(values))
        throw new Error('keyring');
      for (const [id, value] of Object.entries(values)) {
        if (typeof value !== 'string') throw new Error('key');
        const key = Buffer.from(value, 'base64');
        if (key.length !== 32 || key.toString('base64') !== value)
          throw new Error('key');
        this.keys.set(id, key);
      }
    } catch {
      this.keys.clear();
    }
  }
  ready() {
    if (!this.active || !this.keys.has(this.active))
      fail(503, 'BOOTSTRAP_UNAVAILABLE', '访客接入尚未配置，请稍后再试');
  }
  seal(value: unknown, aad: string) {
    this.ready();
    const nonce = randomBytes(12);
    const cipher = createCipheriv(
      'aes-256-gcm',
      this.keys.get(this.active)!,
      nonce,
    );
    cipher.setAAD(Buffer.from(aad));
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(value), 'utf8'),
      cipher.final(),
    ]);
    return {
      keyId: this.active,
      nonce: nonce.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    };
  }
  open(value: Record<string, unknown>, aad: string): unknown {
    try {
      const key = this.keys.get(String(value.keyId));
      if (!key) throw new Error('missing key');
      const decipher = createDecipheriv(
        'aes-256-gcm',
        key,
        Buffer.from(String(value.nonce), 'base64'),
      );
      decipher.setAAD(Buffer.from(aad));
      decipher.setAuthTag(Buffer.from(String(value.tag), 'base64'));
      return JSON.parse(
        Buffer.concat([
          decipher.update(Buffer.from(String(value.ciphertext), 'base64')),
          decipher.final(),
        ]).toString('utf8'),
      );
    } catch {
      return fail(
        503,
        'BOOTSTRAP_RECOVERY_UNAVAILABLE',
        '暂时无法恢复，请保留当前页面并重试',
      );
    }
  }
}
