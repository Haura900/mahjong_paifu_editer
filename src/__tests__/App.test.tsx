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

  it('opens each selected round at its final state', async () => {
    const { container } = render(<App />)
    expect(await screen.findByText(/全 11 局/)).toBeInTheDocument()
    const slider = screen.getByRole('slider', { name: /^巡目/ })
    expect(slider).toHaveValue(slider.getAttribute('max'))

    const eastTwo = [...container.querySelectorAll('.round-list strong')]
      .find((element) => element.textContent === '東2局')
    fireEvent.click(eastTwo!.closest('button')!)
    expect(slider).toHaveValue(slider.getAttribute('max'))
    expect(Number(slider.getAttribute('max'))).toBeGreaterThan(0)
  })

  it('opens compatible JSON in a copyable text box while retaining file save', async () => {
    render(<App />)
    expect(await screen.findByText(/全 11 局/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /互換JSONをコピー/ }))
    const textbox = await screen.findByRole('textbox', { name: '編集済み牌譜JSON' })
    expect(() => JSON.parse((textbox as HTMLTextAreaElement).value)).not.toThrow()
    expect(screen.getByRole('button', { name: /ファイルにも保存/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /クリップボードへコピー/ })).toBeInTheDocument()
  })

  it('builds an AI prompt from the visible table and user instruction', async () => {
    render(<App />)
    expect(await screen.findByText(/全 11 局/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /AI・スクリプト/ }))
    expect(await screen.findByRole('dialog', { name: 'AI・テキスト編集' })).toBeInTheDocument()

    const instruction = '上家の7巡目の4pを10巡目へずらす'
    fireEvent.change(screen.getByRole('textbox', { name: '加工したい内容' }), { target: { value: instruction } })
    fireEvent.click(screen.getByRole('button', { name: 'AI用テキストを生成' }))

    const prompt = screen.getByRole('textbox', { name: 'AIに渡すテキスト' }) as HTMLTextAreaElement
    expect(prompt.value).toContain(instruction)
    expect(prompt.value).toContain('# 余っている字牌')
    expect(prompt.value).toContain('# スクリプト仕様')
    expect(prompt.value).toContain('SELF=')
    expect(prompt.value).toContain('KAMI=')
    sampleText.match(/"name":\s*\[([^\]]+)/)?.[1]
      ?.split(',')
      .map((name) => name.replaceAll('"', '').trim())
      .forEach((name) => expect(prompt.value).toContain(name))
  })

  it('fixes the selected analysis user at the bottom and reminds the East-1 wind on copy', async () => {
    const { container } = render(<App />)
    expect(await screen.findByText(/全 11 局/)).toBeInTheDocument()
    fireEvent.change(screen.getByRole('combobox', { name: '分析ユーザー' }), { target: { value: '1' } })

    expect(container.querySelector('.player-bottom .player-name')).toHaveTextContent('はうらC')
    expect(screen.getByRole('checkbox', { name: '下に固定' })).toBeChecked()

    fireEvent.click(screen.getByRole('button', { name: /互換JSONをコピー/ }))
    const dialog = await screen.findByRole('dialog', { name: /JSONをコピー/ })
    expect(dialog).toHaveTextContent('分析視点: はうらC（東1局では南家）')
    expect(dialog).toHaveTextContent('東1局がこのJSONから削除されていても')
    const copied = JSON.parse((screen.getByRole('textbox', { name: '編集済み牌譜JSON' }) as HTMLTextAreaElement).value)
    expect(copied.log).toHaveLength(11)
    expect(copied.name[1]).toBe('はうらC')
  })

  it('copies the selected round and repeats the same round on paste', async () => {
    const { container } = render(<App />)
    expect(await screen.findByText(/全 11 局/)).toBeInTheDocument()
    const paste = screen.getByRole('button', { name: 'この局の後へペースト' })
    expect(paste).toBeDisabled()

    const eastTwoRounds = [...container.querySelectorAll('.round-list strong')]
      .filter((element) => element.textContent === '東2局')
    fireEvent.click(eastTwoRounds[0]!.closest('button')!)
    fireEvent.click(screen.getByRole('button', { name: 'この局をコピー' }))
    expect(paste).toBeEnabled()
    fireEvent.click(paste)

    expect(await screen.findByText(/全 12 局/)).toBeInTheDocument()
    const repeatedEastTwoRounds = [...container.querySelectorAll('.round-list strong')]
      .filter((element) => element.textContent === '東2局')
    expect(repeatedEastTwoRounds).toHaveLength(eastTwoRounds.length + 1)
  })

  it('keeps only the selected round and restores deleted rounds with undo', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<App />)
    expect(await screen.findByText(/全 11 局/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'この局だけ残す' }))
    expect(await screen.findByText(/全 1 局/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '元に戻す' }))
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
