const REQUIRED_PNPM_CONTENT_SHA512 =
  "sha512.1c5971f9f8442cf756c02c2ba6afc2b5dd56c5da11a740368a0ddbd0de328989c4690b7614043c830f90712f861e18a302c1376c3cb660ad2b2bda16ce47687e";

const testTrustOverrides = new WeakMap<object, string>();

export function trustedPnpmContentSha512(options: object): string {
  return testTrustOverrides.get(options) ?? REQUIRED_PNPM_CONTENT_SHA512;
}

export function setTrustedPnpmContentSha512ForTest(
  options: object,
  sha512: string
): void {
  testTrustOverrides.set(options, sha512);
}
