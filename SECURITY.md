# Security Policy

This repository carries the **Nika client SDK**. Security-relevant
surface here · the SDK runs inside consumer applications and talks to a
local Nika engine — input handling, transport, and dependency supply
chain matter.

## Supported Versions

Only the latest published package version and `main` receive fixes.

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
