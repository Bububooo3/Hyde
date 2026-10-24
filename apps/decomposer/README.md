# Hyde Image Decomposer workspace

This local application owns `decomposer.html` and uses root `src/decomposer/` for its deterministic engine, `src/decomposer-ui/` for the browser editor, and `src/decomposerCli.ts` for the CLI. Those sources stay beside Hyde's shared model, renderer, and archive code so native export can call the actual SDK without copying the engine. The app's independently built web and CLI artifacts live in `apps/decomposer/dist/`.

From the repository root, run `npm run build -w @hyde/decomposer` or `npm run test -w @hyde/decomposer`. The editor's own build remains `npm run build`.
