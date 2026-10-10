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

const { meta: tableMeta, leaveRequests } = useTableHeader()

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
      <header class="border-b border-default">
        <div class="max-w-[1240px] mx-auto px-4 h-14 flex items-center gap-2.5">
          <NuxtLink
            to="/"
            class="mr-auto focus-visible:outline-2 outline-primary/40 rounded-md"
          >
            <AppLogo />
          </NuxtLink>
          <template v-if="tableMeta">
            <UBadge
              :label="`Hand #${tableMeta.handNo}`"
              color="neutral"
              variant="soft"
              class="max-sm:hidden"
            />
            <UBadge
              :label="`Blinds ${tableMeta.smallBlind}/${tableMeta.bigBlind}`"
              color="neutral"
              variant="outline"
            />
            <UButton
              icon="i-lucide-log-out"
              color="neutral"
              variant="ghost"
              size="sm"
              aria-label="Leave table"
              @click="leaveRequests++"
            >
              <span class="max-sm:hidden">Leave table</span>
            </UButton>
          </template>
          <UColorModeButton />
        </div>
      </header>

      <main class="flex-1">
        <NuxtPage />
      </main>

      <footer class="max-w-[1240px] w-full mx-auto px-4 py-6">
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
