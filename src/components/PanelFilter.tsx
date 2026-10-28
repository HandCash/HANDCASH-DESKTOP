import { useMemo, useState, type KeyboardEvent, type RefObject } from 'react'
import { SearchField } from './SearchField'
import { SearchIcon } from './icons'
import { TopBarPopover } from './TopBarPopover'
import { playWalletSound } from '../wallet/soundService'
import type { SearchSuggestion } from '../wallet/collectableSearch'

type Props = {
  id: string
  label: string
  placeholder: string
  /** Comma-separated terms; every one must match. */
  value: string
  onValueChange: (value: string) => void
  suggest?: (draft: string, terms: readonly string[]) => SearchSuggestion[]
  /** Items the search leaves, out of all of them. */
  shown: number
  total: number
  /** Region to span on compact shells (same as activity filters). */
  compactAnchorRef?: RefObject<HTMLElement | null>
}

/** Splits a search into its committed terms and the one being typed after the last comma. */
export function splitPanelQuery(value: string): { terms: string[]; draft: string } {
  const parts = value.split(',')
  const draft = parts.pop()!.trim()
  return { terms: parts.map((p) => p.trim()).filter(Boolean), draft }
}

/** Head search: icon button opens a dropdown field (same chrome as filters). */
export function PanelFilter({
  id,
  label,
  placeholder,
  value,
  onValueChange,
  suggest,
  shown,
  total,
  compactAnchorRef,
}: Props) {
  const { terms, draft } = splitPanelQuery(value)
  const [focused, setFocused] = useState(false)
  const [highlight, setHighlight] = useState(0)
  const suggestions = useMemo(
    () => (draft ? (suggest?.(draft, terms) ?? []) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [suggest, value],
  )
  const open = focused && suggestions.length > 0
  const current = open ? Math.min(highlight, suggestions.length - 1) : -1
  const listId = `${id}-hints`
  const active = value.trim().length > 0

  const fill = (term: string) => {
    onValueChange([...terms, term].join(', '))
    setHighlight(0)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (!open) return
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const step = e.key === 'ArrowDown' ? 1 : -1
      setHighlight((current + step + suggestions.length) % suggestions.length)
    } else if ((e.key === 'Enter' || (e.key === 'Tab' && !e.shiftKey)) && current >= 0) {
      e.preventDefault()
      fill(suggestions[current]!.term)
    }
  }

  return (
    <TopBarPopover
      ariaLabel={label}
      title="Search"
      className="panel-search-popover"
      triggerClassName="wallet-nav-chrome-btn"
      contentClassName="panel-search-popover-content"
      active={active}
      compactAnchorRef={compactAnchorRef}
      onTrigger={() => {
        playWalletSound('soft')
        requestAnimationFrame(() => {
          document.getElementById(id)?.focus()
        })
      }}
      trigger={
        <>
          <SearchIcon size={16} />
          {active ? <span className="wallet-nav-chrome-dot" aria-hidden /> : null}
        </>
      }
    >
      <div className="panel-filter" data-aeon-scope="panel-filter">
        <SearchField
          id={id}
          label={label}
          placeholder={placeholder}
          value={value}
          onValueChange={(next) => {
            onValueChange(next)
            setHighlight(0)
          }}
          onKeyDown={onKeyDown}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={listId}
          aria-activedescendant={current >= 0 ? `${listId}-${current}` : undefined}
        />
        {open ? (
          <ul id={listId} className="panel-filter-suggestions" role="listbox" aria-label="Matches">
            {suggestions.map((s, index) => (
              <li
                key={s.term}
                id={`${listId}-${index}`}
                role="option"
                aria-selected={index === current}
                data-highlight={index === current ? '' : undefined}
                onMouseEnter={() => setHighlight(index)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => fill(s.term)}
              >
                <span className="panel-filter-suggestion-label">{s.label}</span>
                <span className="panel-filter-suggestion-kind">{s.kind}</span>
                <span className="panel-filter-suggestion-count">{s.count}</span>
              </li>
            ))}
          </ul>
        ) : null}
        <span className="sr-only" role="status">
          {value.trim() ? `${shown} of ${total}` : ''}
        </span>
      </div>
    </TopBarPopover>
  )
}
