// hls.js ships no types for its light build: it is the full build's API, less what a Live stream never uses.
declare module "hls.js/light" {
  export * from "hls.js";
  export { default } from "hls.js";
}
