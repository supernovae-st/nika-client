import { createRequire } from 'node:module';
import path from 'node:path';
import { NikaConfigurationError } from '../../errors.js';
import { NikaEngineUnavailable } from './error.js';
import { packageForHost } from './packages.js';

const requireFromBundle = createRequire(
  typeof __filename === 'string' ? __filename : import.meta.url,
);

export interface BinaryResolverHost {
  platform?: NodeJS.Platform;
  arch?: string;
  glibc?: boolean;
  env?: NodeJS.ProcessEnv;
  resolvePackageJson?: (specifier: string) => string;
}

export interface ResolvedNikaEngine {
  bin: string;
  packageName?: string;
  packageRoot?: string;
}

/** Resolve only explicit configuration or the exact package for this host. */
export function resolveNikaBinary(
  configuredBin?: string,
  host: BinaryResolverHost = {},
): string {
  return resolveNikaEngine(configuredBin, host).bin;
}

/** Resolve the executable plus package metadata needed for first-use verification. */
export function resolveNikaEngine(
  configuredBin?: string,
  host: BinaryResolverHost = {},
): ResolvedNikaEngine {
  if (configuredBin !== undefined) {
    if (configuredBin.length === 0) {
      throw new NikaConfigurationError('bin must be a non-empty string');
    }
    return { bin: configuredBin };
  }

  const envBin = (host.env ?? process.env).NIKA_BIN;
  if (envBin !== undefined) {
    if (envBin.length === 0) {
      throw new NikaConfigurationError('NIKA_BIN must be a non-empty string');
    }
    return { bin: envBin };
  }

  const platform = host.platform ?? process.platform;
  const arch = host.arch ?? process.arch;
  const packageName = packageForHost(
    platform,
    arch,
    host.glibc ?? runtimeIsGlibc(platform),
  );
  if (!packageName) throw new NikaEngineUnavailable(platform, arch);

  try {
    const packageJson = (host.resolvePackageJson ?? requireFromBundle.resolve)(
      `${packageName}/package.json`,
    );
    const packageRoot = path.dirname(packageJson);
    return {
      bin: path.join(packageRoot, 'bin', 'nika'),
      packageName,
      packageRoot,
    };
  } catch (cause) {
    if (isMissingModule(cause)) {
      throw new NikaEngineUnavailable(platform, arch, packageName);
    }
    throw cause;
  }
}

function runtimeIsGlibc(platform: NodeJS.Platform): boolean {
  if (platform !== 'linux') return true;
  const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: unknown } };
  return typeof report?.header?.glibcVersionRuntime === 'string';
}

function isMissingModule(cause: unknown): boolean {
  return cause instanceof Error
    && 'code' in cause
    && (cause as NodeJS.ErrnoException).code === 'MODULE_NOT_FOUND';
}
