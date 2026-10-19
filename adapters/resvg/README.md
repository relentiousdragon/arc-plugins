# SVG to PNG

`arc.resvg` renders SVG markup to PNG using the Rust [resvg](https://github.com/linebender/resvg) library.

## Use it in a graph

Install **Resvg SVG Renderer** from **Plugin Store → Store**, then add **Render SVG**. Connect the SVG string to its `SVG` input. The node returns a PNG data URL, width, and height.

To send the image, connect `PNG data URL` to **Send Message → File Data URL / Base64**, and set **File Name** to `image.png`. To show it in an embed, set the embed image URL to `attachment://image.png` on the same message.

Limits: 1 MiB SVG input, 4096 px per dimension, 16 megapixels, 2.9 MB PNG output, and a 5-second execution limit.

## License

The adapter glue is MIT licensed. Resvg and the Rust crates retain their own licenses, see [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md) and the manifest's third-party notices.
