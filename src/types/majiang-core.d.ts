declare module '@kobalab/majiang-core' {
  interface ShoupaiValue {
    toString(): string
  }

  interface MajiangCore {
    Shoupai: {
      fromString(value: string): ShoupaiValue
    }
    Util: {
      xiangting(hand: ShoupaiValue): number
    }
  }

  const core: MajiangCore
  export default core
}
