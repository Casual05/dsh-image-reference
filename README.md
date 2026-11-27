# dsh-image-reference

> [中文](README.zh.md) | English

Reduce repeated historical image uploads in long DSH conversations. The plugin keeps recent images in the request and represents eligible older images with a read-only attachment reference, a generated description, and optionally a smaller thumbnail.

## Why

A long conversation resends every image on every turn, so request size and vision tokens keep growing with the history. This plugin inlines an image only on the turn it first appears, then swaps older ones for a read-only path, a model-written description, and optionally a 320 px thumbnail — the model keeps its memory of the image without paying for the bytes again.

## Install

Run this in PowerShell from the plugin directory.

```powershell
dsh plugin --profile web add (Get-Location).Path
```

Restart DSH after installation or an update. Open **Settings → Plugins → dsh-image-reference → Configure** to customize it. Use one of `dsh-image-reference` and `dsh-image-once` per profile since both wrap the provider adapters.

## Behavior

- The first image occurrence follows the normal DSH path. It becomes eligible for replacement after a successful stream on a route known to accept images. Failed and interrupted calls retain the original image for retries.
- By default, the latest user turn and its tool images retain full images. For eligible older images with a readable attachment, descriptions and thumbnails are prepared in the background.
- When background generation fails, eligible images can use a path or cached thumbnail. A recovered description is added when it is ready. Previously replaced images also keep using a path or thumbnail while descriptions are rebuilt. Images offloaded by DSH use text references.
- Descriptions and thumbnails can be turned off independently. The settings card also controls recent-turn retention, disk persistence, and on-demand rebuilding of descriptions. Persistence and storage-location changes take effect on restart.

## Description presets

- **Auto** chooses a preset and extracts fields in the same background call. Select **Standard** or **Error screenshot** in the settings card to override it, or set `caption.preset` to `standard` or `error-screenshot` in YAML.
- **Standard** captures image type, a brief summary, visible text, and uncertain details. **Error screenshot** captures the readable error, file, line, column, and related code lines. Exact fields that exceed the description budget are omitted as whole fields.
- Validated structured fields are saved alongside the compact text used in future requests. A plain-text response can still serve as a description. A custom `caption.prompt` continues to control its own description flow.

Descriptions may omit details or contain transcription errors. For exact details, use `read_image` when the attachment path, tool, and a vision route are available. The local file is DSH's normalized copy, which may have been resized or re-encoded.

## Cost and privacy

- A description generally takes one additional image call per attachment and description configuration. Selecting a different provider sends the image to that provider. Thumbnails still use visual tokens.
- Prompt-cache behavior depends on the provider. End-to-end latency depends on image transport, cache hits, and follow-up tool calls.
- The default state is `~/.dsh/profiles/<profile>/image-reference/state.json`. It can contain screenshot text in plaintext. Clear existing memory before switching off disk persistence if you want to remove the saved cache contents.

## Validation

Run `node test/run.mjs` or `npm test`. This plugin targets DSH 0.2.x. Installation and adapter behavior were verified locally on DSH 0.2.2-alpha.2.

See the [original design draft](DESIGN.zh.md) in Chinese.
