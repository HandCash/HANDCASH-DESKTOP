# @aeon-ui/site

Small helpers for **link previews** (Open Graph + Twitter Card meta tags).

```ts
import { absoluteUrl, openGraphHeadHtml } from '@aeon-ui/site'

const html = openGraphHeadHtml({
  title: 'Aeon UI — Future-proof UI infrastructure',
  description: 'Statechart-driven primitives and a styled layer your team controls.',
  url: absoluteUrl('https://aeon-ui.com', '/'),
  image: absoluteUrl('https://aeon-ui.com', '/og-aeon-ui-engine.png'),
  siteName: 'Aeon UI',
})
```

Use in a Vite `transformIndexHtml` hook or any static site generator. Pair with a **1200×630** `og.png` in `public/`.

Not required for component consumers — optional for docs and marketing apps in the monorepo.
