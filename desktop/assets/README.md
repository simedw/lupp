# Lupp icon

`lupp-icon.png` shows a realistic folding jeweller's loupe on a warm off-white rounded-square tile. The loupe has a charcoal barrel, lime rim, optical glass and brushed-metal case. Outer corners and margins are transparent. Used for the app window, macOS Dock, and page icon; included in the npm package.

The loupe artwork was created with the built-in image generation tool. Its geometry and transparency are now exported using the deterministic process below.

## Native geometry export

The generated image is retained as `lupp-icon-source.png`. The shipped PNG is now rebuilt deterministically with `npm run icon:build` (macOS and Xcode required **only to regenerate the icon**). Normal builds and installs use the checked-in PNG.

The exporter preserves the loupe artwork, composites it onto an opaque, full-bleed 1024×1024 background, and uses Apple's installed Icon Composer renderer for the corner shape. `Lupp.icon` is the editable native source. For Electron's flattened Dock-image path, the rendered tile is fitted to 824×824 pixels with 100px transparent margins. This matches the 206px tile measured in Apple's installed 256px Notes icon; it is an export convention, not padding applied to the native source layers.

The build checks dimensions, alpha bounds, centre opacity and empty margins. `test/icon.test.ts` checks the shipped PNG too. No Apple app artwork is included.

References: [Apple app icon guidance](https://developer.apple.com/design/human-interface-guidelines/app-icons), [Electron Dock API](https://www.electronjs.org/docs/latest/api/dock). Electron's runtime Dock-image API consumes the flattened PNG, not the layered `.icon` document.

## Original artwork prompts

Use case: compositing. Edit target: the supplied Lupp loupe app icon. Keep the realistic folding loupe's exact design, perspective, charcoal barrel, lime rim, blue-green optical glass, and brushed silver case. Add a macOS-style rounded-square background tile behind it. Tile: warm ivory/off-white, very subtle satin shading and softly rounded continuous corners, front-facing perfectly square, NOT tilted, NOT a thick 3D block. Square canvas. Tile occupies about 82% of the canvas width and height with equal transparent outer margins, like a well-proportioned Mac Dock app icon. Scale the loupe down slightly to fit entirely inside the tile with comfortable internal padding; keep it centered and large enough to read at small sizes. A restrained soft contact shadow under the loupe ON the tile is fine. Preserve real transparent alpha outside the rounded-square tile and at the canvas corners. No checkerboard, no opaque square outside the tile, no text, no additional symbols, no redesign of the loupe, no pixel art. Deliver one finished app icon PNG.

Background cleanup prompts:

Background extraction only. The supplied image is the edit target. Preserve the complete warm off-white rounded-square app tile and the realistic loupe inside it EXACTLY, including the tile shape, dimensions, padding, shadows inside the tile, and object design. Remove ONLY the baked-in white/gray checkerboard outside the rounded-square tile. Replace that exterior area with actual PNG transparency (alpha zero). Keep square canvas, same placement and scale. Do not redraw, enlarge, crop or change the icon. Do not make the cream tile transparent. No replacement background color or checkerboard. Output RGBA PNG with real transparent corners and margins.

Make the background transparent. Remove the gray-and-white checkerboard surrounding the cream rounded-square icon. Keep the cream rounded square and loupe intact. Deliver a transparent-background PNG cutout, with alpha channel, not a picture of a checkerboard. Preserve the existing square canvas and padding.
