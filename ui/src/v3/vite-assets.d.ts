// Vite asset-URL imports (e.g. `import url from "./worklet.js?url"`).
declare module "*?url" {
  const url: string;
  export default url;
}
