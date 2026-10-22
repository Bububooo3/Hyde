# Hyde Story Studio

## Blurb

I recently planned and built a browser-based animation studio called Hyde. Hyde is meant to be an intuitive all-in-one package for making animated stories efficiently, and I originally planned it with TV shows in-mind. When I say browser-based, I also mean entirely local. The editor is intentionally a static webpage, and users can export projects as webpages, gifs, videos, or ".hy/.hyde" XML project files they can return to. Since one evaluator drives the editor, the player, and every export, the preview always matches the output. 

I used Codex to actually make it in a few days. Because I'd defined the plan in milestones, the agents kept burning my credits like step 1 was the end goal. A super helpful technique was telling it to limit parallel work (there were 9 sub-agents), connect already-implemented features to the UI, and stop polishing things that already worked. After that I started getting around an hour of efficient work out of 6 Sol Ultra at a time before running out of 5-hr credits (I'm on the student trial).

Regarding features, I focused on applying concepts I found generally interesting and/or useful to this specific field. 

"Rigs" are called assemblies, which are parent parts that own collections of shapes with joints (fixed/hinge/slider). Animation clips are stored on assemblies and have optional automatic tweening between final/initial poses. Assemblies can also be exported separately for distribution and reuse (".hyproj").

Users can link animation segments called scenes through displays like mini-player, split-screen, etc., so editing a source scene updates every place it appears (to prevent infinity). I designed audio to work like a voiceover (play the scene while you record) and also allow imports. Audio can be manipulated by the usual video-editor means and also implements sound modifiers (equalizer, distortion, reverb, etc.).

I thought it'd be cool to use Pretext to implement a text element more powerful and fun than the traditional ones. Words can wrap around shapes, animate, and stay editable simultaneously.

And finally, the AI part of the project, which I think especially differentiates Hyde from similar editors in the field. The final product uses a TypeScript SDK and browser interface. Why? So an AI agent can take user instructions and a set of assets and produce notable results. The TypeScript SDK is magnitudes more efficient than a cloud computer and human-central interface, and basically lets agents create ".hy" projects using the same validation/saving code as the editor. And the added bonus is that the editor functions as an agent's visual interface to inspect a live project and export. The agent's creative iteration loop has multiple levels of user-control (auto, collaborative, directed) explained in a broader informative workflow document (for agents to read) and it is essentially build, preview, fix ugly things, and give the user a video or a Hyde project to edit themselves. 

I also thought to implement an image decomposer, although I wasn't sure of feasibility at first. It takes stylized images preferably and converts them exclusively into Hyde assemblies. For now, since this is a pet project, it does not rely on ML. Rather, it uses color segmentation, contour tracing, polygon fitting, etc. and compares the product to the original for iteration. There's a static mode (for buildings and decor) and an animate mode (for characters), which really just help decide what the program should prioritize. In animate mode, users are asked to highlight/group regions and set joints. There's no backend on any part of this project, including the AI part and image decomposition tool.

## Development

Node 24+, then `npm ci`, `npm run dev`. `npm test` runs engine/storage tests; `npm run build` typechecks and builds static files.

For static deployment, upload the **contents** of `dist/` to one HTTPS directory, including `index.html`, `player.html`, `build-manifest.json`, `assets/`, `portable/`, and `licenses/`. Hyde uses relative URLs, so that directory may be a site subpath. Serve JavaScript, CSS, JSON, and fonts with their normal MIME types. Microphone access requires HTTPS or localhost. Projects and imported assets stay in the visitor's browser unless they explicitly save or export a file. A plain static server under `/hyde/` is exercised by `tests/deployment-static.spec.ts`.

Project files: `.hyde` (default) or `.hy`. These extensions contain the same versioned project archive format; `.hy` is an alternate filename extension, not a separate file type. Complete assembly files use `.hyproj`. The archives contain XML metadata and media assets.

See `docs/PLAN.md` and `docs/PROGRESS.md` for the intended product and verified implementation status. Hyde does not upload user projects or media.
