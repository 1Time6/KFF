/** Types for scripts/source-hash.mjs, which plain Node runs without a TypeScript step. */
export declare function sourceText(file: string): string;
export declare function sourceHash(file: string): string;
export declare function bufferHash(bytes: Uint8Array): string;
