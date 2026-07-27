declare module '@kobalab/majiang-core' {
  interface ShoupaiValue {
    toString(): string
  }

  interface HuleResult {
    hupai?: { name: string; fanshu?: number | string }[]
    fenpei: number[]
  }

  interface MajiangCore {
    rule(): Record<string, unknown>
    Shoupai: {
      fromString(value: string): ShoupaiValue
    }
    Util: {
      xiangting(hand: ShoupaiValue): number
      hule_param(value: Record<string, unknown>): Record<string, unknown>
      hule(
        hand: ShoupaiValue,
        ronTile: string | null,
        parameters: Record<string, unknown>,
      ): HuleResult | undefined
    }
  }

  const core: MajiangCore
  export default core
}
