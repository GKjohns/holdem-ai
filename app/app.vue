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

const { meta: tableMeta, leaveRequests, costCap } = useTableHeader()
/** Decision models cost fractions of a cent; keep three decimals so the meter visibly moves. */
const costLabel = computed(() => tableMeta.value ? `$${tableMeta.value.costUsd.toFixed(tableMeta.value.costUsd < 10 ? 3 : 2)}` : '')

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
            <UPopover :content="{ align: 'end' }">
              <UButton
                color="neutral"
                :variant="tableMeta.capped ? 'soft' : 'outline'"
                size="sm"
                :class="tableMeta.capped && 'text-warning'"
                :aria-label="`Session cost ${costLabel}, cap $${costCap.toFixed(2)}`"
                data-testid="cost-meter"
              >
                <span class="num text-[13px]">{{ costLabel }}</span>
                <span class="max-sm:hidden text-muted">this session</span>
              </UButton>
              <template #content>
                <div class="p-3.5 w-64">
                  <div class="stat-label">
                    Session cap
                  </div>
                  <UInputNumber
                    v-model="costCap"
                    :min="0.01"
                    :step="0.5"
                    :step-snapping="false"
                    :format-options="{ style: 'currency', currency: 'USD', minimumFractionDigits: 2 }"
                    size="sm"
                    class="mt-1.5 w-full"
                    data-testid="cost-cap"
                  />
                  <p class="mt-2 text-xs text-muted">
                    {{ costLabel }} spent so far (pricing.ts × tokens). At the cap, Watch pauses and Play holds AI turns until you raise it.
                  </p>
                </div>
              </template>
            </UPopover>
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
          <template v-else>
            <UButton
              to="/results"
              icon="i-lucide-trophy"
              color="neutral"
              variant="ghost"
              size="sm"
            >
              Results
            </UButton>
            <UButton
              to="/lab"
              icon="i-lucide-flask-conical"
              color="neutral"
              variant="ghost"
              size="sm"
            >
              Lab
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
