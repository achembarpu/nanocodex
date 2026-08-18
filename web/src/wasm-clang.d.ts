declare module "@eduoj/wasm-clang" {
  export class API {
    constructor(options: {
      hostWrite(message: string): void;
      readBuffer(url: string): Promise<ArrayBuffer>;
      compileStreaming(url: string): Promise<WebAssembly.Module>;
    });
  }
}
