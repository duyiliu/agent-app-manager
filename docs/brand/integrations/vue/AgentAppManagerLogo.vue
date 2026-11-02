<template>
  <img
    :src="source"
    :alt="alt"
    :width="width"
    :height="height"
    decoding="async"
    draggable="false"
    class="aam-logo"
  />
</template>

<script setup lang="ts">
import { computed } from 'vue'

/** Copy assets/svg/* to public/brand/ first. */
const props = withDefaults(defineProps<{
  variant?: 'icon' | 'mark-dark' | 'mark-light' | 'horizontal-dark' | 'horizontal-light'
  size?: number
  basePath?: string
  alt?: string
}>(), {
  variant: 'icon', size: 40, basePath: '/brand', alt: 'Agent App Manager'
})
const files = {
  icon: 'app-icon.svg',
  'mark-dark': 'mark-on-dark.svg',
  'mark-light': 'mark-on-light.svg',
  'horizontal-dark': 'logo-horizontal-on-dark.svg',
  'horizontal-light': 'logo-horizontal-on-light.svg',
}
const source = computed(() => `${props.basePath.replace(/\/$/, '')}/${files[props.variant]}`)
const width = computed(() => props.variant.startsWith('horizontal') ? Math.round(props.size * 850 / 148) : props.size)
const height = computed(() => props.size)
</script>

<style scoped>
.aam-logo { display: block; object-fit: contain; flex-shrink: 0; }
</style>
