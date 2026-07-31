import { useEffect, useId, useState } from 'react'

function ensureMermaid(mermaid: typeof import('mermaid').default) {
  // Always (re)apply compact theme so hot reload / prior init don't keep huge spacing.
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'loose',
    theme: 'base',
    themeVariables: {
      fontFamily: 'IBM Plex Sans, Instrument Sans, system-ui, sans-serif',
      fontSize: '11px',
      primaryColor: '#1a2420',
      primaryTextColor: '#e8f5ef',
      primaryBorderColor: '#38d385',
      lineColor: '#8b9a92',
      secondaryColor: '#121a16',
      tertiaryColor: '#0c1210',
      noteBkgColor: '#15201a',
      noteTextColor: '#c5d4cb',
      noteBorderColor: '#2a3d34',
    },
    state: {
      nodeSpacing: 28,
      rankSpacing: 32,
      fontSize: 11,
    },
  })
}

type Props = {
  source: string
  title?: string
}

/** Compact Mermaid state diagram for Settings → Statecharts. */
export function MermaidDiagram({ source, title }: Props) {
  const reactId = useId().replace(/:/g, '')
  const [svg, setSvg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const mermaid = (await import('mermaid')).default
        ensureMermaid(mermaid)
        const { svg: rendered } = await mermaid.render(
          `hc-mmd-${reactId}-${source.length}`,
          source,
        )
        if (!cancelled) {
          setSvg(rendered)
          setError(null)
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Diagram failed to render')
          setSvg(null)
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [source, reactId])

  return (
    <figure className="statechart-figure" data-aeon-part="mermaid">
      {title ? <figcaption className="sr-only">{title}</figcaption> : null}
      {error ? (
        <pre className="statechart-error">{error}</pre>
      ) : svg ? (
        <div
          className="statechart-mermaid"
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      ) : (
        <p className="statechart-loading">Rendering…</p>
      )}
    </figure>
  )
}
