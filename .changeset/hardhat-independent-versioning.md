---
"hardhat-matchstick-ts": patch
---

Version independently of `matchstick-ts`, and declare the versions this plugin supports.

`matchstick-ts` is now a peer dependency instead of a hard dependency, with a wide compatible range
(`>=0.4.2 <1.0.0`), alongside `hardhat` (`^3`).

Compatibility is proven by the `packages/example` integration suite, which drives `matchstick-ts`
through this plugin on every change and gates every publish. A `matchstick-ts` release that breaks
the plugin fails CI before either package is published, and a new `hardhat-matchstick-ts` version is
released only when that happens (or when the plugin itself changes). The two packages therefore
version independently instead of moving together.
