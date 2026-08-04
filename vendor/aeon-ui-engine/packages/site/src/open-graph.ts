export type OpenGraphConfig = {
  title: string
  description: string
  /** Canonical page URL (absolute). */
  url: string
  /** Share image URL (absolute). Recommend 1200×630 PNG or JPEG. */
  image: string
  imageAlt?: string
  siteName?: string
  locale?: string
  type?: 'website' | 'article'
  twitterCard?: 'summary_large_image' | 'summary'
  themeColor?: string
}

export type MetaTag = {
  tag: 'meta' | 'link'
  name?: string
  property?: string
  content?: string
  rel?: string
  href?: string
}

/** Flat list of meta/link tags for Open Graph + Twitter cards. */
export function openGraphTags(config: OpenGraphConfig): MetaTag[] {
  const {
    title,
    description,
    url,
    image,
    imageAlt = title,
    siteName = title,
    locale = 'en_US',
    type = 'website',
    twitterCard = 'summary_large_image',
    themeColor = '#0c0e12',
  } = config

  return [
    { tag: 'meta', name: 'description', content: description },
    { tag: 'meta', name: 'theme-color', content: themeColor },
    { tag: 'meta', property: 'og:type', content: type },
    { tag: 'meta', property: 'og:site_name', content: siteName },
    { tag: 'meta', property: 'og:locale', content: locale },
    { tag: 'meta', property: 'og:title', content: title },
    { tag: 'meta', property: 'og:description', content: description },
    { tag: 'meta', property: 'og:url', content: url },
    { tag: 'meta', property: 'og:image', content: image },
    { tag: 'meta', property: 'og:image:secure_url', content: image },
    { tag: 'meta', property: 'og:image:type', content: 'image/png' },
    { tag: 'meta', property: 'og:image:alt', content: imageAlt },
    { tag: 'meta', property: 'og:image:width', content: '1200' },
    { tag: 'meta', property: 'og:image:height', content: '630' },
    { tag: 'meta', name: 'twitter:card', content: twitterCard },
    { tag: 'meta', name: 'twitter:title', content: title },
    { tag: 'meta', name: 'twitter:description', content: description },
    { tag: 'meta', name: 'twitter:image', content: image },
    { tag: 'meta', name: 'twitter:image:alt', content: imageAlt },
  ]
}

export function renderMetaTag(tag: MetaTag): string {
  if (tag.tag === 'link') {
    return `<link rel="${tag.rel}" href="${escapeAttr(tag.href ?? '')}" />`
  }
  if (tag.property) {
    return `<meta property="${tag.property}" content="${escapeAttr(tag.content ?? '')}" />`
  }
  return `<meta name="${tag.name}" content="${escapeAttr(tag.content ?? '')}" />`
}

/** HTML fragment to inject before `</head>`. */
export function openGraphHeadHtml(config: OpenGraphConfig): string {
  return openGraphTags(config).map(renderMetaTag).join('\n    ')
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
}

/** Resolve a public asset path against a site origin. */
export function absoluteUrl(origin: string, path: string): string {
  const base = origin.replace(/\/$/, '')
  const p = path.startsWith('/') ? path : `/${path}`
  return `${base}${p}`
}
