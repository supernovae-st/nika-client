export const NATIVE_PACKAGES = {
  'darwin-arm64': '@supernovae-st/nika-darwin-arm64',
  'darwin-x64': '@supernovae-st/nika-darwin-x64',
  'linux-x64': '@supernovae-st/nika-linux-x64-gnu',
  'linux-arm64': '@supernovae-st/nika-linux-arm64-gnu',
} as const;

export type NativePackageName = (typeof NATIVE_PACKAGES)[keyof typeof NATIVE_PACKAGES];

export function packageForHost(
  platform: NodeJS.Platform,
  arch: string,
  glibc: boolean,
): NativePackageName | undefined {
  if (platform === 'linux' && !glibc) return undefined;
  return NATIVE_PACKAGES[`${platform}-${arch}` as keyof typeof NATIVE_PACKAGES];
}
