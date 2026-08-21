/**
 * Verify compatible workflow service webhook signatures (Stripe-style HMAC-SHA256).
 *
 * Signature header format: "t=<unix_timestamp>,v1=<hmac_sha256_hex>"
 * Signed payload: "<timestamp>.<body>"
 */
export async function verifyWebhookSignature(
  payload: string,
  signatureHeader: string,
  secret: string,
  tolerance = 300,
): Promise<boolean> {
  // Parse "t=<timestamp>,v1=<hmac_hex>"
  const parts = signatureHeader.split(',');
  const timestampStr = parts.find(p => p.startsWith('t='))?.slice(2);
  const signature = parts.find(p => p.startsWith('v1='))?.slice(3);

  if (!timestampStr || !signature) return false;

  const timestamp = parseInt(timestampStr, 10);
  if (!Number.isFinite(timestamp)) return false;

  // Check timestamp tolerance
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > tolerance) return false;

  // Compute expected HMAC-SHA256
  const signedPayload = `${timestampStr}.${payload}`;

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  const sig = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(signedPayload),
  );

  const expected = Array.from(new Uint8Array(sig))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  // Constant-time comparison
  if (expected.length !== signature.length) return false;
  let result = 0;
  for (let i = 0; i < expected.length; i++) {
    result |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  return result === 0;
}
