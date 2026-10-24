<!-- markdownlint-configure-file { "MD043": { "headings": ["# Changelog", "## [Unreleased]", "*"] } } -->

# Changelog

All notable changes are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `createAuthServer({ admit, end })`: an app decides whether the relay admits a connection whose token checks out, and is told when each connection closes, to apply its own limits ([Admission](docs/architecture.md#admission)). `authServer` admits every connection whose token checks out, as before.
