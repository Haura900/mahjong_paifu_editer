import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '../App'

const sampleText = readFileSync(resolve(process.cwd(), 'sample.txt'), 'utf8')

describe('browser-facing editor workflow', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(sampleText),
    }))
    class MockWorker {
      onmessage: ((event: MessageEvent) => void) | null = null
      onerror: ((event: ErrorEvent) => void) | null = null
      postMessage() {}
      terminate() {}
    }
    vi.stubGlobal('Worker', MockWorker)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('loads sample, navigates, selects a physical tile and previews an edit', async () => {
    const { container } = render(<App />)
    expect(await screen.findByText(/全 11 局/)).toBeInTheDocument()
    expect(screen.getByRole('region', { name: '麻雀卓' })).toBeInTheDocument()

    const slider = screen.getByRole('slider', { name: /^巡目/ })
    fireEvent.change(slider, { target: { value: '8' } })
    expect(slider).toHaveValue('8')

    const tile = container.querySelector<HTMLButtonElement>('[data-tile-id]')
    expect(tile).not.toBeNull()
    fireEvent.click(tile!)
    expect(await screen.findByText('牌を交換')).toBeInTheDocument()

    const replacement = screen.getAllByTitle(/へ変更/).find((button) => !(button as HTMLButtonElement).disabled)
    expect(replacement).toBeDefined()
    fireEvent.click(replacement!)
    expect(await screen.findByText('連鎖する変更を確認')).toBeInTheDocument()
    expect(screen.getByText('ユーザー指定と固定値を維持したまま、変更コストが最小の合法解を探索しています。')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '探索をキャンセル' }))
    expect(screen.queryByText('連鎖する変更を確認')).not.toBeInTheDocument()
  }, 20_000)
})
