# Security Policy

This repository carries the **Nika client SDK** (`@supernovae-st/nika`).
Security-relevant surface here · the SDK runs inside consumer applications
and talks to a local Nika engine or to a `nika serve` over HTTP(S) — input
handling, transport, and dependency supply chain matter.

## Supported Versions

0.124 is Nika's current release line. Work stays focused on maintenance,
security and the media capabilities workflows need; native video is planned
for 0.125. The **0.124.x** line (the latest published package version) and
`main` receive fixes, which ship as 0.124.x releases. Older versions,
including the previous 0.123.x line and the retired
`@supernovae-st/nika-client` package name, receive none. See the
[known limits](https://docs.nika.sh/changelog/known-limits) of 0.124.

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub
issues, discussions, or pull requests.**

Send an email to **security@supernovae.studio** with ·

- A description of the vulnerability and where it lives
- Steps to reproduce or a minimal proof-of-concept
- The package version / commit SHA where you observed it

We acknowledge receipt within **72 hours** and aim for a substantive
response (initial triage + ETA) within **7 days**.

## Disclosure Process

1. **Triage** · maintainers verify the report and confirm the scope
2. **Fix development** · patch authored privately
3. **Public release** · GitHub Security Advisory + patched package
4. **Credit** · reporter named in the advisory unless anonymity is requested

We aim for **≤90 days** between report and public disclosure, shorter for
actively-exploited issues.
