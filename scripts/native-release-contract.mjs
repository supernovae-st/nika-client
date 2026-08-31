import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, readFile } from 'node:fs/promises';

const TARGETS = new Map([
  ['@supernovae-st/nika-darwin-arm64', {
    os: 'darwin', cpu: 'arm64', libc: null, assetPlatform: 'macos', assetArch: 'arm64',
  }],
  ['@supernovae-st/nika-darwin-x64', {
    os: 'darwin', cpu: 'x64', libc: null, assetPlatform: 'macos', assetArch: 'x64',
  }],
  ['@supernovae-st/nika-linux-arm64', {
    os: 'linux', cpu: 'arm64', libc: 'glibc', assetPlatform: 'linux', assetArch: 'arm64',
  }],
  ['@supernovae-st/nika-linux-x64', {
    os: 'linux', cpu: 'x64', libc: 'glibc', assetPlatform: 'linux', assetArch: 'x64',
  }],
]);

export function nativeTarget(packageName, version) {
  const target = TARGETS.get(packageName);
  if (!target) throw new Error(`Unknown native package ${String(packageName)}`);
  return {
    ...target,
    asset: `nika-${target.assetPlatform}-${target.assetArch}-${version}.tar.gz`,
  };
}

export function assertNativeManifest(manifest, version) {
  const target = nativeTarget(manifest.name, version);
  if (manifest.version !== version) {
    throw new Error(`${manifest.name} version ${String(manifest.version)} != ${version}`);
  }
  assertSingle(manifest.os, target.os, `${manifest.name} os`);
  assertSingle(manifest.cpu, target.cpu, `${manifest.name} cpu`);
  if (target.libc === null) {
    if (manifest.libc !== undefined) {
      throw new Error(`${manifest.name} must not declare libc`);
    }
  } else {
    assertSingle(manifest.libc, target.libc, `${manifest.name} libc`);
  }
  return target;
}

export async function inspectExecutable(file) {
  const handle = await open(file, 'r');
  try {
    const metadata = await handle.stat();
    const header = Buffer.alloc(64);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    if (bytesRead < 32) throw new Error(`${file} is too short to be a native executable`);
    const detected = inspectExecutableHeader(header);
    if (detected.format === 'elf64') {
      await assertElfStructure(handle, header, metadata.size);
    } else {
      await assertMachOStructure(handle, header, metadata.size, detected.littleEndian);
    }
    return { os: detected.os, cpu: detected.cpu, format: detected.format };
  } finally {
    await handle.close();
  }
}

export function inspectExecutableHeader(header) {
  if (
    header[0] === 0x7f
    && header[1] === 0x45
    && header[2] === 0x4c
    && header[3] === 0x46
  ) {
    if (header[4] !== 2) throw new Error('Nika release executable must be 64-bit ELF');
    const littleEndian = header[5] === 1;
    const bigEndian = header[5] === 2;
    if (!littleEndian && !bigEndian) throw new Error('ELF executable has an unknown byte order');
    const machine = littleEndian ? header.readUInt16LE(18) : header.readUInt16BE(18);
    const cpu = machine === 62 ? 'x64' : machine === 183 ? 'arm64' : undefined;
    if (!cpu) throw new Error(`Unsupported ELF machine ${machine}`);
    return { os: 'linux', cpu, format: 'elf64', littleEndian };
  }

  const magic = header.readUInt32LE(0);
  if (magic === 0xfeedfacf || magic === 0xcffaedfe) {
    const littleEndian = magic === 0xfeedfacf;
    const cpuType = littleEndian ? header.readUInt32LE(4) : header.readUInt32BE(4);
    const cpu = cpuType === 0x01000007 ? 'x64' : cpuType === 0x0100000c ? 'arm64' : undefined;
    if (!cpu) throw new Error(`Unsupported Mach-O CPU type 0x${cpuType.toString(16)}`);
    return { os: 'darwin', cpu, format: 'mach-o64', littleEndian };
  }

  throw new Error('Nika release executable is neither ELF64 nor Mach-O 64-bit');
}

export async function assertExecutableTarget(file, target) {
  const actual = await inspectExecutable(file);
  if (actual.os !== target.os || actual.cpu !== target.cpu) {
    throw new Error(
      `${file} is ${actual.os}-${actual.cpu} (${actual.format}), expected ${target.os}-${target.cpu}`,
    );
  }
  return actual;
}

export async function assertExecutableIdentity(file, version, commit) {
  if (!isCommit(commit)) throw new Error('engine commit must be 40 lowercase hex');
  const expected = `${version} (${commit.slice(0, 9)})`;
  const matches = (await readFile(file)).toString('latin1')
    .match(/\b\d+\.\d+\.\d+ \([0-9a-f]{9}\)/g) ?? [];
  if (matches.length !== 1 || matches[0] !== expected) {
    throw new Error(
      `${file} embeds engine identities [${matches.join(', ')}], expected exactly ${expected}`,
    );
  }
}

export function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', () => resolve(hash.digest('hex')));
  });
}

export function checksumForAsset(contents, asset) {
  const matches = [];
  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(/^([0-9a-f]{64})\s+\*?(.+)$/);
    if (match?.[2] === asset) matches.push(match[1]);
  }
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one SHA256SUMS entry for ${asset}, found ${matches.length}`);
  }
  return matches[0];
}

export function isSha256(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

export function isCommit(value) {
  return typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
}

function assertSingle(value, expected, label) {
  if (!Array.isArray(value) || value.length !== 1 || value[0] !== expected) {
    throw new Error(`${label} must be exactly [${JSON.stringify(expected)}]`);
  }
}

async function assertElfStructure(handle, header, fileSize) {
  const littleEndian = header[5] === 1;
  const u16 = (offset) => littleEndian ? header.readUInt16LE(offset) : header.readUInt16BE(offset);
  const u32 = (offset) => littleEndian ? header.readUInt32LE(offset) : header.readUInt32BE(offset);
  const u64 = (buffer, offset) => safeUInt64(
    littleEndian ? buffer.readBigUInt64LE(offset) : buffer.readBigUInt64BE(offset),
    'ELF offset',
  );
  const type = u16(16);
  const version = u32(20);
  const entry = u64(header, 24);
  const programOffset = u64(header, 32);
  const headerSize = u16(52);
  const programEntrySize = u16(54);
  const programCount = u16(56);
  if (
    ![2, 3].includes(type)
    || version !== 1
    || entry === 0
    || headerSize !== 64
    || programEntrySize !== 56
    || programCount < 1
    || programCount > 4096
  ) {
    throw new Error('ELF64 header does not describe a bounded executable image');
  }
  const tableSize = programEntrySize * programCount;
  if (programOffset < headerSize || programOffset + tableSize > fileSize) {
    throw new Error('ELF64 program header table lies outside the executable');
  }
  const table = Buffer.alloc(tableSize);
  const { bytesRead } = await handle.read(table, 0, table.length, programOffset);
  if (bytesRead !== table.length) throw new Error('Cannot read the complete ELF64 program table');

  let executableLoad = false;
  for (let index = 0; index < programCount; index += 1) {
    const offset = index * programEntrySize;
    const segmentType = littleEndian ? table.readUInt32LE(offset) : table.readUInt32BE(offset);
    if (segmentType !== 1) continue;
    const flags = littleEndian ? table.readUInt32LE(offset + 4) : table.readUInt32BE(offset + 4);
    const fileOffset = u64(table, offset + 8);
    const virtualAddress = u64(table, offset + 16);
    const fileBytes = u64(table, offset + 32);
    const memoryBytes = u64(table, offset + 40);
    if (fileBytes > memoryBytes || fileOffset + fileBytes > fileSize) {
      throw new Error('ELF64 load segment lies outside the executable');
    }
    if (
      (flags & 1) !== 0
      && entry >= virtualAddress
      && entry < virtualAddress + memoryBytes
    ) {
      executableLoad = true;
    }
  }
  if (!executableLoad) throw new Error('ELF64 entry point is not in an executable load segment');
}

async function assertMachOStructure(handle, header, fileSize, littleEndian) {
  const u32 = (buffer, offset) => littleEndian
    ? buffer.readUInt32LE(offset)
    : buffer.readUInt32BE(offset);
  const u64 = (buffer, offset) => safeUInt64(
    littleEndian ? buffer.readBigUInt64LE(offset) : buffer.readBigUInt64BE(offset),
    'Mach-O offset',
  );
  const fileType = u32(header, 12);
  const commandCount = u32(header, 16);
  const commandBytes = u32(header, 20);
  if (
    fileType !== 2
    || commandCount < 1
    || commandCount > 4096
    || commandBytes < 8
    || 32 + commandBytes > fileSize
  ) {
    throw new Error('Mach-O header does not describe a bounded executable image');
  }
  const commands = Buffer.alloc(commandBytes);
  const { bytesRead } = await handle.read(commands, 0, commands.length, 32);
  if (bytesRead !== commands.length) throw new Error('Cannot read the complete Mach-O commands');

  let cursor = 0;
  let executableSegment = false;
  let entryPoint = false;
  for (let index = 0; index < commandCount; index += 1) {
    if (cursor + 8 > commands.length) throw new Error('Mach-O command header is truncated');
    const command = u32(commands, cursor);
    const commandSize = u32(commands, cursor + 4);
    if (commandSize < 8 || cursor + commandSize > commands.length) {
      throw new Error('Mach-O load command lies outside the command table');
    }
    if (command === 0x19) {
      if (commandSize < 72) throw new Error('Mach-O segment command is truncated');
      const fileOffset = u64(commands, cursor + 40);
      const segmentBytes = u64(commands, cursor + 48);
      const initialProtection = u32(commands, cursor + 60);
      if (fileOffset + segmentBytes > fileSize) {
        throw new Error('Mach-O segment lies outside the executable');
      }
      if ((initialProtection & 4) !== 0 && segmentBytes > 0) executableSegment = true;
    }
    if (command === 0x80000028) {
      if (commandSize < 24) throw new Error('Mach-O entry-point command is truncated');
      const entryOffset = u64(commands, cursor + 8);
      if (entryOffset >= fileSize) throw new Error('Mach-O entry point lies outside the executable');
      entryPoint = true;
    }
    cursor += commandSize;
  }
  if (cursor !== commands.length || !executableSegment || !entryPoint) {
    throw new Error('Mach-O image lacks a complete executable segment or entry point');
  }
}

function safeUInt64(value, label) {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${label} exceeds safe range`);
  return Number(value);
}
