// three.js 同梱の meshoptimizer 簡略化モジュールの型（使う部分だけ）
declare module 'three/addons/libs/meshopt_simplifier.module.js' {
  export const MeshoptSimplifier: {
    ready: Promise<void>;
    supported: boolean;
    simplifyWithAttributes(
      indices: Uint32Array,
      positions: Float32Array,
      positionsStride: number,
      attributes: Float32Array,
      attributesStride: number,
      attributeWeights: number[],
      lock: Uint8Array | null,
      targetIndexCount: number,
      targetError: number,
      flags: string[],
    ): [Uint32Array, number];
  };
}
