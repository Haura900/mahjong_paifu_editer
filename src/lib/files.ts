export function downloadText(filename: string, contents: string, type = 'application/json'): void {
  const blob = new Blob([contents], { type })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}

export async function saveText(
  filename: string,
  contents: string,
  description: string,
  options: { mimeType?: string; extensions?: string[] } = {},
): Promise<'direct' | 'download'> {
  const mimeType = options.mimeType ?? 'application/json'
  const extensions = options.extensions ?? ['.json', '.mjpe']
  const picker = (window as unknown as {
    showSaveFilePicker?: (options: unknown) => Promise<{
      createWritable(): Promise<{ write(value: string): Promise<void>; close(): Promise<void> }>
    }>
  }).showSaveFilePicker
  if (picker) {
    try {
      const handle = await picker({
        suggestedName: filename,
        types: [{ description, accept: { [mimeType]: extensions } }],
      })
      const writable = await handle.createWritable()
      await writable.write(contents)
      await writable.close()
      return 'direct'
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error
    }
  }
  downloadText(filename, contents, mimeType)
  return 'download'
}

export function readFileText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error('ファイルを読み込めません'))
    reader.readAsText(file)
  })
}
