import { describe, expect, it } from 'vitest'
import { buildTenhouJsonUrl, findAnalysisSeatByName } from '../tenhouUrl'

describe('Tenhou JSON viewer URL', () => {
  it.each([0, 1, 2, 3] as const)('places seat %s before the JSON fragment', (seat) => {
    const json = JSON.stringify({ name: ['東', '南', '西', '北'], log: [] })
    const url = buildTenhouJsonUrl(json, seat)

    expect(url).toBe(`https://tenhou.net/5/?tw=${seat}#json=${encodeURIComponent(json)}`)
    expect(JSON.parse(decodeURIComponent(url.split('#json=')[1]!))).toEqual(JSON.parse(json))
  })

  it('finds the remembered player in their new seat and otherwise leaves it unselected', () => {
    expect(findAnalysisSeatByName(['A', 'B', 'C', 'D'], 'C')).toBe(2)
    expect(findAnalysisSeatByName(['A', 'B', 'C', 'D'], 'unknown')).toBeUndefined()
    expect(findAnalysisSeatByName(['A', 'B', 'C', 'D'])).toBeUndefined()
  })
})
