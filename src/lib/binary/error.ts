import { NikaError } from '../../errors.js';

/** The local engine could not be resolved without an implicit PATH lookup. */
export class NikaEngineUnavailable extends NikaError {
  readonly code = 'NIKA_ENGINE_UNAVAILABLE';
  readonly platform: string;
  readonly arch: string;
  readonly packageName?: string;

  constructor(platform: string, arch: string, packageName?: string) {
    const target = `${platform}-${arch}`;
    const detail = packageName
      ? `the optional payload ${packageName} is not installed`
      : 'there is no packaged payload for this host';
    super(
      `Nika engine unavailable for ${target}: ${detail}. `
      + 'Install optional dependencies, set NIKA_BIN, or pass config.bin.',
    );
    this.name = 'NikaEngineUnavailable';
    this.platform = platform;
    this.arch = arch;
    this.packageName = packageName;
  }
}
