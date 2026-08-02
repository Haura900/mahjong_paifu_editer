import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
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
    cleanup()
    vi.unstubAllGlobals()
  })

  it('keeps the table interactive while edits are queued in a worker', async () => {
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
    expect(screen.queryByText('連鎖する変更を確認')).not.toBeInTheDocument()
    const another = screen.getAllByTitle(/へ変更/)
      .find((button) => button !== replacement && !(button as HTMLButtonElement).disabled)
    expect(another).toBeDefined()
    fireEvent.click(another!)
    fireEvent.click(screen.getByRole('button', { name: /変更ログ/ }))
    expect(await screen.findByRole('dialog', { name: '変更ログ' })).toBeInTheDocument()
    expect(screen.getAllByText('牌を変更')).toHaveLength(2)
    expect(screen.getByText(/2件 処理中/)).toBeInTheDocument()
  }, 20_000)

  it('opens compatible JSON in a copyable text box while retaining file save', async () => {
    render(<App />)
    expect(await screen.findByText(/全 11 局/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /互換JSONをコピー/ }))
    const textbox = await screen.findByRole('textbox', { name: '編集済み牌譜JSON' })
    expect(() => JSON.parse((textbox as HTMLTextAreaElement).value)).not.toThrow()
    expect(screen.getByRole('button', { name: /ファイルにも保存/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /クリップボードへコピー/ })).toBeInTheDocument()
  })

  it('selects an analysis viewpoint and repeats or deletes the current round', async () => {
    render(<App />)
    expect(await screen.findByText(/全 11 局/)).toBeInTheDocument()

    const viewpoint = screen.getByRole('combobox', { name: '分析視点' })
    fireEvent.change(viewpoint, { target: { value: '1' } })
    expect(viewpoint).toHaveValue('1')
    expect(screen.getByRole('option', { name: 'はうらC' })).toBeInTheDocument()

    const paste = screen.getByRole('button', { name: '貼付' })
    expect(paste).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'コピー' }))
    expect(paste).toBeEnabled()
    fireEvent.click(paste)
    expect(await screen.findByText(/全 12 局/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '削除' }))
    expect(await screen.findByText(/全 11 局/)).toBeInTheDocument()
  })

  it('asks before creating a meld that the current discard cannot support', async () => {
    render(<App />)
    expect(await screen.findByText(/全 11 局/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'チー' }))
    const dialog = await screen.findByRole('dialog', { name: 'チーの形を作る' })
    expect(dialog).toHaveTextContent(/ではチーできません/)
    expect(screen.getByRole('button', { name: 'キャンセル' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '変更を続ける' }))
    fireEvent.click(screen.getByRole('button', { name: '4萬・5萬・6萬を選ぶ' }))
    fireEvent.click(screen.getByRole('button', { name: 'この形を作る' }))
    expect(screen.queryByRole('dialog', { name: 'チーの形を作る' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /変更ログ/ }))
    expect(screen.getAllByText('副露を追加').length).toBeGreaterThan(1)
  }, 20_000)
})
