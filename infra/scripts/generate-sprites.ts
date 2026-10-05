import { resolve } from "node:path";
import { probe } from "../../packages/media-core/src/index.js";
import { spriteThumbnails } from "../../packages/media-core/src/sprites.js";

const [sourceArg, outputArg] = process.argv.slice(2);
if (!sourceArg || !outputArg) {
  console.error("Usage: npm run media:sprites -- <source-video> <output-directory>");
  process.exit(2);
}

const source = resolve(sourceArg);
const output = resolve(outputArg);
const metadata = await probe(source);
const result = await spriteThumbnails(source, output, metadata.duration);
console.log(JSON.stringify({ source, output, duration: metadata.duration, ...result }, null, 2));
