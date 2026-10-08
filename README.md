<p align="center">
  <img src="https://raw.githubusercontent.com/relayforsi/relayforsi-sdk/8517101fa9a5de2268742676f13fa746c9a298a3/assets/banner.png" alt="relayfor.si: the fees-to-AI layer for launchpads" width="100%">
</p>

<p align="center">
  <a href="https://docs.relayfor.si">Docs</a> ·
  <a href="https://docs.relayfor.si/api">API reference</a> ·
  <a href="https://relayfor.si">relayfor.si</a>
</p>

# relayforsi-sdk

TypeScript SDKs for [relayfor.si](https://relayfor.si).

| Package                                 | Description                                         |
| --------------------------------------- | --------------------------------------------------- |
| [`relayfor.si`](packages/sdk)           | API client, wallet signing and webhook verification |
| [`@relayforsi/ai-sdk`](packages/ai-sdk) | Provider for the Vercel AI SDK                      |

## Development

```sh
pnpm install
pnpm generate   # generate types from the OpenAPI document
pnpm check      # typecheck, lint, test, build and package checks
```

Types are generated from the OpenAPI document and are not committed. Set
`RELAYFOR_OPENAPI_URL` to use a different URL or a local file.

`openapi.lock.json` records the shape of the API the SDK was built against. When the API changes,
`pnpm generate:check` fails and lists the changes. Run `pnpm spec:accept` and commit the updated
lock with the corresponding SDK changes.

Other checks:

- `scripts/check-consumers.sh` type-checks the packed package with TypeScript 5.4, 5.9 and 7.0.
- `scripts/smoke.mjs` runs the packed package on Node.js, Bun and Deno.
- `node scripts/pack-files.mjs` checks the files each package publishes.

## Releases

Releases are created by release-please from conventional commits: merging its release PR tags
the release, and the `npm` environment (the owner's approval) publishes it from GitHub Actions
through npm trusted publishing, with provenance and no stored token.

## License

MIT
