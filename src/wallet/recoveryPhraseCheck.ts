import { Mnemonic } from '@bsv/sdk'

const WORDS = new Set(new Mnemonic().Wordlist.value)
const LENGTHS = [12, 15, 18, 21, 24]

export function recoveryPhraseWords(input: string): string[] {
  return input.trim().toLowerCase().split(/\s+/).filter(Boolean)
}

/**
 * What is wrong with a recovery phrase, in words the holder can act on, or
 * null when it is a valid phrase. A valid phrase can still belong to another
 * wallet; only the restore itself shows that.
 */
export function recoveryPhraseProblem(input: string): string | null {
  const words = recoveryPhraseWords(input)
  if (words.length === 0) return 'Enter your recovery phrase.'
  const unknown = words
    .map((word, index) => ({ word, at: index + 1 }))
    .filter(({ word }) => !WORDS.has(word))
  if (unknown.length > 0) {
    const named = unknown.slice(0, 3).map(({ word, at }) => `word ${at} (“${word}”)`).join(', ')
    return `Not a recovery phrase word: ${named}. Check the spelling.`
  }
  if (!LENGTHS.includes(words.length)) {
    return `A recovery phrase has 12 or 24 words; this has ${words.length}.`
  }
  try {
    Mnemonic.fromString(words.join(' '))
  } catch {
    return 'Every word is valid, but one is wrong or out of order. Check each word against your backup.'
  }
  return null
}
