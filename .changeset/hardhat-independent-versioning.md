---
"hardhat-matchstick-ts": patch
---

Version independently of `matchstick-ts`, and declare the versions this plugin supports.

`matchstick-ts` is now a peer dependency with an explicit compatible range instead of a hard
dependency, alongside `hardhat`. `hardhat-matchstick-ts` therefore states the `hardhat` and
`matchstick-ts` versions it works with, and is no longer force-bumped on every `matchstick-ts`
release.
