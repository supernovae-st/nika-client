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
      ? `the optional payload ${packageName} is not installed `
        + '(npm leaves it UNMET OPTIONAL when the registry has no version matching this client)'
      : 'there is no packaged payload for this host';
    super(
      `Nika engine unavailable for ${target}: ${detail}. `
      + 'A nika found on PATH is deliberately not used. '
      + 'Set NIKA_BIN=/absolute/path/to/nika, pass config.bin, '
      + 'or install the matching payload package.',
    );
    this.name = 'NikaEngineUnavailable';
    this.platform = platform;
    this.arch = arch;
    this.packageName = packageName;
  }
}
