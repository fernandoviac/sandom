import colorBytes from "@sandom/color/color.wasm" with { type: "bytes" };
import gainMapBytes from "@sandom/gain-map/gain-map.wasm" with { type: "bytes" };
import pngBytes from "@sandom/png/png-codec.wasm" with { type: "bytes" };
import harfbuzzBytes from "../../vendor/hb.wasm" with { type: "bytes" };
import msdfgenBytes from "../../vendor/msdfgen.wasm" with { type: "bytes" };
// Byte imports belong to the reviewed module graph, not ambient worker I/O.
// Seed the eager default renderer before importing the worker implementation;
// the component's runtime then owns these explicit assets, including its PNG
// codec, without filesystem or network permissions.


globalThis[Symbol.for("sandom.hbBytes")] = harfbuzzBytes;
globalThis[Symbol.for("sandom.colorBytes")] = colorBytes;
globalThis[Symbol.for("sandom.gainMapBytes")] = gainMapBytes;
globalThis[Symbol.for("sandom.msdfgenBytes")] = msdfgenBytes;
globalThis.window = globalThis;
const { installComponentWorker } = await import("./component-worker-runtime.js");
await installComponentWorker({
  assets: {
    harfbuzz: harfbuzzBytes,
    msdfgen: msdfgenBytes,
    codecs: { png: pngBytes },
  },
});
