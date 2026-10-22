# Hyde Story Studio

Hyde is a local-first story studio for creating mixed-media stories with animation, text, images, video, and audio. The product is under active development.

## Development

Node 24+, then `npm ci`, `npm run dev`. `npm test` runs engine/storage tests; `npm run build` typechecks and builds static files.

For static deployment, upload the **contents** of `dist/` to one HTTPS directory, including `index.html`, `player.html`, `build-manifest.json`, `assets/`, `portable/`, and `licenses/`. Hyde uses relative URLs, so that directory may be a site subpath. Serve JavaScript, CSS, JSON, and fonts with their normal MIME types. Microphone access requires HTTPS or localhost. Projects and imported assets stay in the visitor's browser unless they explicitly save or export a file. A plain static server under `/hyde/` is exercised by `tests/deployment-static.spec.ts`.

Project files: `.hyde` (default) or `.hy`. These extensions contain the same versioned project archive format; `.hy` is an alternate filename extension, not a separate file type. Complete assembly files use `.hyproj`. The archives contain XML metadata and media assets.

See `docs/PLAN.md` and `docs/PROGRESS.md` for the intended product and verified implementation status. Hyde does not upload user projects or media.
