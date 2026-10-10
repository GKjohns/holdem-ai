<script setup lang="ts">
useHead({
  meta: [
    { name: 'viewport', content: 'width=device-width, initial-scale=1' }
  ],
  link: [
    { rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' }
  ],
  htmlAttrs: {
    lang: 'en'
  }
})

const title = 'Hold\'em AI'
const description = 'Play no-limit Texas Hold\'em against a table of AI models, then see how each one reasoned once the hand is over.'

useSeoMeta({
  title,
  description,
  ogTitle: title,
  ogDescription: description,
  twitterCard: 'summary'
})
</script>

<template>
  <UApp>
    <div class="min-h-screen flex flex-col">
      <header class="max-w-6xl w-full mx-auto px-4 pt-6 flex items-center justify-between">
        <div class="flex items-baseline gap-3">
          <NuxtLink
            to="/"
            class="focus-visible:outline-2 outline-primary/40 rounded-md"
          >
            <AppLogo />
          </NuxtLink>
          <span class="text-sm text-muted">no-limit, against the models</span>
        </div>
        <div class="flex items-center gap-1">
          <UColorModeButton />
        </div>
      </header>

      <main class="flex-1">
        <NuxtPage />
      </main>

      <footer class="max-w-6xl w-full mx-auto px-4 py-6">
        <a
          href="https://monumentlabs.io"
          target="_blank"
          rel="noopener"
          class="text-xs text-dimmed hover:underline hover:text-muted"
        >Monument Labs</a>
      </footer>
    </div>
  </UApp>
</template>
