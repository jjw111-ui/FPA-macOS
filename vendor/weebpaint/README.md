# WeebPaint v0.12.31

This directory contains the unmodified standalone drawing application by
fangzhangmnm, vendored from the user's original downloaded release backup.

- Release: https://github.com/fangzhangmnm/weebpaint/releases/tag/v0.12.31
- Asset: https://github.com/fangzhangmnm/weebpaint/releases/download/v0.12.31/weebpaint-standalone-v0.12.31.html
- Embedded application version: `v0.12.31-2026-09-04`
- Original size: `4961295` bytes
- SHA-256: `044e8bfb44bbc8531a9d04f4018f33b00bc2f33eaaa7cac9c837a4370edf18d5`
- License: MIT, verified against the release tag's original
  https://raw.githubusercontent.com/fangzhangmnm/weebpaint/v0.12.31/LICENSE
  on 2026-09-16. The verbatim license is included as `LICENSE`.

The original HTML also retains its own library and SVG icon notices, including
Bootstrap/Feather MIT notices and Lucide's ISC notice. Those notices remain in
both the vendored original and the generated application.

Run `node scripts/build-full-paint.mjs` from the repository root to regenerate
`public/design-workbench/full-paint.html`. A different compatible standalone
file may be supplied as the first argument; upstream anchor checks deliberately
fail when an incompatible version is supplied.

The generator preserves the complete native drawing engine. It namespaces local
storage and databases, prevents embedded startup document recovery from replacing
the host-selected document, leaves the host in charge of application updates, adds
a local-only network policy, and injects the host document/region bridge. The FPA
theme and toolbar enhancements are separate adjacent files. Native OpenRaster
projects keep the original archive format and original `.weebpaint` metadata.
