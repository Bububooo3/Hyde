# Hyde Story Studio

Hyde is a local-first story studio for creating mixed-media stories with animation, text, images, video, and audio. The product is under active development.

## Development

Node 24+, then `npm ci`, `npm run dev`. `npm test` runs engine/storage tests; `npm run build` typechecks and builds static files. Deploy the contents of `dist/` on static HTTPS hosting.

Project files: `.hyde` (default) or `.hy`. These extensions contain the same versioned project archive format; `.hy` is an alternate filename extension, not a separate file type. Complete assembly files use `.hyproj`. The archives contain XML metadata and media assets.

See `docs/PLAN.md` and `docs/PROGRESS.md` for the intended product and verified implementation status. Hyde does not upload user projects or media.
