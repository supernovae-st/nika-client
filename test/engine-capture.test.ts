import { describe, expect, it } from 'vitest';
import { NikaProtocolError } from '../src/errors.js';
import { captureEngine } from '../src/lib/engine-capture.js';

const capture = (program: string, bufferBytes = 1024) => captureEngine(
  process.execPath, ['--input-type=module', '-e', program],
  { bufferBytes, transport: 'native-process', label: 'test machine output', killGraceMs: 100 },
);

describe('bounded machine capture decoding', () => {
  it('preserves UTF-8 characters split across stdout chunks', async () => {
    const result = await capture(`
      const bytes = Buffer.from('雪é😀');
      for (const byte of bytes) {
        process.stdout.write(Buffer.from([byte]));
        await new Promise(resolve => setTimeout(resolve, 5));
      }
    `, Buffer.byteLength('雪é😀'));
    expect(result.stdout).toBe('雪é😀');
    expect(result.exitCode).toBe(0);
  });

  it.each([{ bytes: [0xff] }, { bytes: [0xe9, 0x9b] }, { bytes: [0xed, 0xa0, 0x80] }])(
    'rejects invalid or truncated stdout bytes $bytes', async ({ bytes }) => {
      const error = await capture(`process.stdout.write(Buffer.from(${JSON.stringify(bytes)}));`)
        .catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(NikaProtocolError);
      expect((error as Error).message).toMatch(/stdout was not valid UTF-8/);
    },
  );

  it('keeps malformed diagnostic stderr permissive and counts its raw bytes', async () => {
    const result = await capture('process.stdout.write("{}"); process.stderr.write(Buffer.from([255,255,255]));', 3);
    expect(result.stdout).toBe('{}');
    expect(result.stderr).toBe('\ufffd\ufffd\ufffd');
  });

  it.each(['stdout', 'stderr'])('rejects raw %s overflow and settles a non-exiting producer', async (stream) => {
    await expect(capture(`
      process.${stream}.write(Buffer.alloc(17, 32));
      setInterval(() => {}, 1000);
    `, 16)).rejects.toThrow(/exceeded 16 bytes/);
  });
});
