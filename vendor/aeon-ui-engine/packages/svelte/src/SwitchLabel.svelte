<script lang="ts">
  import { partAttrs, switchAnatomy } from '@aeon-ui/core'

  let { children, ...rest }: { children?: import('svelte').Snippet } & Record<string, unknown> = $props()

  const attrs = partAttrs(switchAnatomy.scope, switchAnatomy.label)
</script>

<span {...attrs} {...rest}>{@render children?.()}</span>
